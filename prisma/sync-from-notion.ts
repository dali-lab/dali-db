/**
 * Notion → Postgres sync script
 *
 * Pulls DALI members, projects, hired roles, and project assignments from
 * Notion and upserts them into the shared Postgres database via Prisma.
 * Safe to run multiple times — all writes use notionPageId as the
 * idempotency key.
 *
 * Known limitations:
 *   - Members with no email in Notion get a placeholder "notion-{pageId}@dali".
 *   - Members with duplicate emails in Notion (duplicate entries) also get
 *     placeholders for the second occurrence.
 *
 * Usage:
 *   npm run db:sync
 *
 * Required env vars:
 *   DATABASE_URL                    — Postgres connection string
 *   NOTION_TOKEN                    — Notion integration token
 *   NOTION_MEMBERS_DB_ID            — Notion DB: members
 *   NOTION_PROJECT_CARDS_DB_ID      — Notion DB: project cards (source of truth)
 *   NOTION_PROJECT_TRACKING_DB_ID   — Notion DB: project tracking (supplemental)
 *   NOTION_HIRED_ROLES_DB_ID        — Notion DB: hired roles
 *   NOTION_PROJECT_ASSIGNMENTS_DB_ID — Notion DB: project assignments
 *
 * The public projects DB (9bbcc845675f4ace99c4a91112a89d78) is hardcoded — it's
 * the same public-facing DB used by the website and does not change.
 */

import { Client } from "@notionhq/client";
import { PrismaClient, Role, Level, ProjectStatus, RepoType, ProjectPreference } from "../lib/generated/index.js";

// ─── Clients ─────────────────────────────────────────────────────────────────

if (!process.env.NOTION_TOKEN) throw new Error("NOTION_TOKEN is not set");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
if (!process.env.NOTION_MEMBERS_DB_ID) throw new Error("NOTION_MEMBERS_DB_ID is not set");
if (!process.env.NOTION_PROJECT_CARDS_DB_ID) throw new Error("NOTION_PROJECT_CARDS_DB_ID is not set");
if (!process.env.NOTION_PROJECT_TRACKING_DB_ID) throw new Error("NOTION_PROJECT_TRACKING_DB_ID is not set");
if (!process.env.NOTION_HIRED_ROLES_DB_ID) throw new Error("NOTION_HIRED_ROLES_DB_ID is not set");
if (!process.env.NOTION_PROJECT_ASSIGNMENTS_DB_ID) throw new Error("NOTION_PROJECT_ASSIGNMENTS_DB_ID is not set");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const prisma = new PrismaClient({ log: ["error"] });

// ─── Notion database IDs (from env) ────────────────────────────────────────────

const MEMBERS_DB_ID              = process.env.NOTION_MEMBERS_DB_ID;
const PROJECT_CARDS_DB_ID        = process.env.NOTION_PROJECT_CARDS_DB_ID;
const PROJECT_TRACKING_DB_ID     = process.env.NOTION_PROJECT_TRACKING_DB_ID;
const HIRED_ROLES_DB_ID          = process.env.NOTION_HIRED_ROLES_DB_ID;
const PROJECT_ASSIGNMENTS_DB_ID  = process.env.NOTION_PROJECT_ASSIGNMENTS_DB_ID;
// Public-facing projects DB — same one the website uses for published projects
const PUBLIC_PROJECTS_DB_ID      = process.env.NOTION_PUBLIC_PROJECTS_DB_ID;
const BIDS_DB_ID                 = "2b7fe958d92f80f68100edef8335b46c";

// ─── Term helpers ─────────────────────────────────────────────────────────────

const SEASON_START_MONTH: Record<string, number> = { W: 0, S: 3, X: 6, F: 8 };
const SEASON_END_MONTH: Record<string, number>   = { W: 2, S: 5, X: 7, F: 11 };

function termToDateRange(term: string): { startDate: Date; endDate: Date } | null {
  const match = term.match(/^(\d{2})([FWSX])$/i);
  if (!match) return null;
  const year = parseInt(match[1], 10) + 2000;
  const season = match[2].toUpperCase();
  return {
    startDate: new Date(year, SEASON_START_MONTH[season], 1),
    endDate: new Date(year, SEASON_END_MONTH[season] + 1, 0),
  };
}

function getCurrentAcademicYearTerms(): Set<string> {
  const now = new Date();
  const month = now.getMonth();
  const yy = now.getFullYear() % 100;
  const fallYear = month >= 8 ? yy : yy - 1;
  const springYear = fallYear + 1;
  return new Set([`${fallYear}F`, `${springYear}W`, `${springYear}S`, `${springYear}X`]);
}

// ─── Role / Level mapping ─────────────────────────────────────────────────────

const ROLE_SKIP_KEYWORDS = new Set([
  "core", "core lead", "director", "staff", "mentor", "alum", "alumni", "3d modeler",
  "graphics", "graphics mentor",
]);

function mapNotionRoleToEnum(raw: string): Role | null {
  const s = raw.toLowerCase().trim();
  if (ROLE_SKIP_KEYWORDS.has(s)) return null;
  if (s.includes("fullstack") || s.includes("full stack") || s.includes("full-stack")) return Role.FULLSTACK;
  if (s.includes("data")) return Role.DATA;
  if (s.includes("engine") || s.includes("engineer")) return Role.ENGINES;
  if (s.includes("ar") || s.includes("vr") || s.includes("xr") || s === "ar/vr") return Role.AR_VR;
  if (s.includes("ui") || s.includes("ux") || s.includes("design")) return Role.UI_UX;
  if (s.includes("video") || s.includes("film") || s.includes("videograph")) return Role.VIDEO;
  if (s.includes("instructor") || s.includes("teaching") || s.includes("teacher")) return Role.INSTRUCTOR;
  if (s === "pm" || s.includes("product manager") || s.includes("product management")) return Role.PM;
  return null;
}

function mapNotionLevelToEnum(raw: string | null | undefined): Level {
  switch (raw?.toUpperCase()) {
    case "P1": return Level.P1;
    case "P2": return Level.P2;
    case "P3": return Level.P3;
    case "C":  return Level.C;
    case "L":  return Level.L;
    default:   return Level.P1;
  }
}

// ─── Notion pagination helper ─────────────────────────────────────────────────

async function queryAll(databaseId: string, options: Record<string, any> = {}): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const response: any = await notion.databases.query({
      database_id: databaseId,
      ...options,
      page_size: 100,
      start_cursor: cursor,
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ─── Field extractors ─────────────────────────────────────────────────────────

function extractMemberTermNames(props: any): string[] {
  const terms: string[] = [];
  for (const t of props["_terms_in_dali"]?.multi_select ?? []) terms.push(t.name);
  if (props["Terms in DALI"]?.formula?.string) {
    for (const t of props["Terms in DALI"].formula.string.split(",")) {
      const trimmed = t.trim();
      if (trimmed && !terms.includes(trimmed)) terms.push(trimmed);
    }
  }
  return terms;
}

function extractMajorMinor(props: any): { major: string | null; minor: string | null } {
  const field = props["major/minor"] || props["Major/Minor"];
  if (!field) return { major: null, minor: null };
  let combined = "";
  if (field.type === "rollup" && field.rollup?.array) {
    combined = field.rollup.array
      .flatMap((item: any) => {
        if (item.type === "multi_select") return item.multi_select.map((s: any) => s.name);
        if (item.type === "select") return [item.select?.name].filter(Boolean);
        if (item.type === "rich_text") return item.rich_text.map((t: any) => t.plain_text);
        return [];
      })
      .filter(Boolean)
      .join(", ");
  } else {
    combined =
      field.rich_text?.[0]?.plain_text ||
      field.select?.name ||
      field.formula?.string ||
      field.multi_select?.map((s: any) => s.name).join(", ") ||
      "";
  }
  const parts = combined.split(/[\/,]/).map((p: string) => p.trim()).filter(Boolean);
  return { major: parts[0] ?? null, minor: parts[1] ?? null };
}

// ─── Step 1: Sync Terms ───────────────────────────────────────────────────────

async function syncTerms(termStrings: Set<string>): Promise<Map<string, string>> {
  console.log(`\n── Syncing ${termStrings.size} terms...`);
  const termIdByName = new Map<string, string>();

  // Fetch existing terms in one query
  const existing = await prisma.term.findMany({ select: { id: true, name: true } });
  for (const t of existing) termIdByName.set(t.name, t.id);

  const toUpsert = [...termStrings].filter(name => termToDateRange(name) !== null);
  await Promise.all(toUpsert.map(async name => {
    const range = termToDateRange(name)!;
    const term = await prisma.term.upsert({
      where: { name },
      update: { startDate: range.startDate, endDate: range.endDate },
      create: { name, startDate: range.startDate, endDate: range.endDate },
      select: { id: true, name: true },
    });
    termIdByName.set(term.name, term.id);
  }));

  console.log(`  ✓ ${termIdByName.size} terms ready`);
  return termIdByName;
}

// ─── Project status mapping ───────────────────────────────────────────────────

function mapNotionProjectStatus(raw: string | null | undefined, termNames: string[]): ProjectStatus {
  const s = raw?.toLowerCase().trim() ?? "";
  let status: ProjectStatus;
  if (s === "continuing" || s === "active") status = ProjectStatus.ACTIVE;
  else if (s === "shipping" || s === "shipped") status = ProjectStatus.SHIPPED;
  else if (s === "inactive" || s === "on hold") status = ProjectStatus.INACTIVE;
  else if (s === "accepted") status = ProjectStatus.ACCEPTED;
  else if (s === "in interview") status = ProjectStatus.IN_INTERVIEW;
  else if (s === "rejected") status = ProjectStatus.REJECTED;
  else status = ProjectStatus.SHIPPED; // default

  // If the project has terms and its last term matches the current term pattern
  // (i.e. "term X of X"), treat it as shipped regardless of Notion status.
  // We detect this by checking if the raw term string includes "of" where the two numbers match.
  if (status === ProjectStatus.ACTIVE && termNames.length > 0) {
    const termOfTermPattern = /(\d+)\s+of\s+(\d+)/i;
    const match = raw?.match(termOfTermPattern);
    if (match && match[1] === match[2]) {
      status = ProjectStatus.SHIPPED;
    }
  }

  return status;
}

// ─── Step 2: Sync Projects ────────────────────────────────────────────────────
// Project Cards DB is the source of truth (name, terms, status, repos).
// Public Projects DB provides display fields (description, sectors, cover, urls).
// Cards and public entries are matched by normalised lowercase name.

async function syncProjects(
  cardPages: any[],
  trackingPages: any[],
  publicPages: any[],
  termIdByName: Map<string, string>,
): Promise<void> {
  console.log(`\n── Syncing ${cardPages.length} project cards + ${publicPages.length} public entries...`);

  // Build tracking data map: tracking page ID → operational fields
  const trackingByPageId = new Map<string, Record<string, any>>();
  for (const page of trackingPages) {
    const p = page.properties;
    trackingByPageId.set(page.id, {
      partnerEmail:   p["Partner Email"]?.email ?? null,
      teamEmail:      p["Team Email"]?.email ?? null,
      zoomLink:       p["Zoom Link"]?.url ?? null,
      figjamUrl:      p["Figjam"]?.url ?? null,
      teamDriveUrl:   p["team drive"]?.url ?? null,
      imageAssetsUrl: p["Image Assets"]?.url ?? null,
      gcalendarUrl:   p["GCalendar"]?.url ?? null,
      weeklySchedule: (p["Weekly Schedule"]?.rich_text ?? []).map((t: any) => t.plain_text).join("") || null,
      agentRepoUrl:   p["Agent Repo"]?.url ?? null,
    });
  }

  // Build public display data map: normalised name → display fields
  const publicByName = new Map<string, {
    publicNotionPageId: string;
    description: string | null;
    sectors: string[];
    product: string[];
    techStack: string[];
    coverImage: string | null;
    projectUrls: Array<{ label: string; url: string }>;
    partnerNames: string[];
  }>();
  for (const page of publicPages) {
    const p = page.properties;
    const rawName =
      (p["Project Name"]?.rich_text?.map((t: any) => t.plain_text).join("") ||
       p.Statement?.title?.map((t: any) => t.plain_text).join("") || "").trim();
    if (!rawName) continue;
    const sectors: string[] = p.Sector?.multi_select?.map((s: any) => s.name) ?? [];
    const product: string[] = p.Product?.multi_select?.map((s: any) => s.name) ?? [];
    const techStack: string[] = p["Tech Stack"]?.multi_select?.map((s: any) => s.name) ?? [];
    const coverImage: string | null =
      page.cover?.file?.url || page.cover?.external?.url ||
      p["Logo Image"]?.files?.[0]?.file?.url || p["Logo Image"]?.files?.[0]?.external?.url || null;
    const projectUrls: Array<{ label: string; url: string }> = [];
    if (p["Link to Website"]?.url) projectUrls.push({ label: "Website", url: p["Link to Website"].url });
    if (p["Link to App"]?.url)     projectUrls.push({ label: "App",     url: p["Link to App"].url });
    if (p["Student Blog"]?.url)    projectUrls.push({ label: "Student Blog", url: p["Student Blog"].url });
    if (p.Press?.url)              projectUrls.push({ label: "Press",   url: p.Press.url });
    const partnerNames: string[] = p.Partner?.multi_select?.map((s: any) => s.name) ?? [];
    const description: string | null = p.Statement?.title?.map((t: any) => t.plain_text).join("").trim() || null;
    publicByName.set(rawName.toLowerCase(), {
      publicNotionPageId: page.id,
      description,
      sectors,
      product,
      techStack,
      coverImage,
      projectUrls,
      partnerNames,
    });
  }

  let ok = 0, fail = 0;

  await Promise.all(cardPages.map(async page => {
    const props = page.properties;
    const notionPageId: string = page.id;
    const name = (props.Name?.title ?? []).map((t: any) => t.plain_text).join("").trim() || "Untitled Project";

    // Terms come from the card's multi_select
    const termNames: string[] = (props.terms?.multi_select ?? []).map((t: any) => t.name);
    const termIds = termNames.map(t => termIdByName.get(t)).filter((id): id is string => !!id);

    // Merge tracking data if linked
    const trackingPageId: string | undefined = props["Project Hub"]?.relation?.[0]?.id;
    const tracking = trackingPageId ? (trackingByPageId.get(trackingPageId) ?? {}) : {};

    // Merge public display data matched by name
    const pub = publicByName.get(name.toLowerCase()) ?? null;

    // Repos come from rollup fields on the card
    const rollupUrl = (key: string) => {
      const arr = props[key]?.rollup?.array ?? [];
      return arr.find((i: any) => i.type === "url")?.url ?? null;
    };

    const rawStatus = props["Status"]?.select?.name ?? props["status"]?.select?.name ?? null;
    const status = mapNotionProjectStatus(rawStatus, termNames);

    const repos: { type: RepoType; url: string }[] = [
      { type: RepoType.FULLSTACK, url: props["Dev Fullstack"]?.url ?? rollupUrl("Frontend Repo-Mobile") },
      { type: RepoType.BACKEND,   url: rollupUrl("Backend Repo") },
      { type: RepoType.DATA,      url: props["Data"]?.url },
      { type: RepoType.AGENT,     url: tracking.agentRepoUrl },
    ].filter(r => !!r.url) as { type: RepoType; url: string }[];

    const { agentRepoUrl: _agent, ...trackingData } = tracking as any;

    const data = {
      name,
      status,
      ...trackingData,
      figmaUrl: props["Figma 1"]?.url ?? rollupUrl("Figma") ?? null,
      // Display fields from public DB (kept if no public match)
      ...(pub ? {
        publicNotionPageId: pub.publicNotionPageId,
        description:        pub.description,
        sectors:            pub.sectors,
        product:            pub.product,
        techStack:          pub.techStack,
        coverImage:         pub.coverImage,
        projectUrls:        pub.projectUrls,
        partnerNames:       pub.partnerNames,
      } : {}),
    };

    try {
      const project = await prisma.project.upsert({
        where: { notionPageId },
        update: { ...data, ...(termIds.length ? { termsInDali: { set: termIds.map(id => ({ id })) } } : {}) },
        create: { ...data, notionPageId, ...(termIds.length ? { termsInDali: { connect: termIds.map(id => ({ id })) } } : {}) },
      });
      await prisma.repo.deleteMany({ where: { projectId: project.id } });
      if (repos.length) {
        await prisma.repo.createMany({ data: repos.map(r => ({ projectId: project.id, type: r.type, url: r.url })) });
      }
      ok++;
    } catch (err: any) {
      console.error(`  ✗ Project "${name}": ${err.message}`);
      fail++;
    }
  }));

  // Upsert public-only projects (published but not in cards DB)
  let pubOnly = 0;
  for (const [, pub] of publicByName) {
    const exists = await prisma.project.findUnique({ where: { publicNotionPageId: pub.publicNotionPageId } });
    if (exists) continue;
    // Find by name match
    const nameMatch = cardPages.find(p =>
      (p.properties.Name?.title ?? []).map((t: any) => t.plain_text).join("").trim().toLowerCase() ===
      [...publicByName.entries()].find(([, v]) => v.publicNotionPageId === pub.publicNotionPageId)?.[0]
    );
    if (nameMatch) continue; // already handled above
    // No card match — create a project from public data only
    try {
      await prisma.project.upsert({
        where: { publicNotionPageId: pub.publicNotionPageId },
        update: { description: pub.description, sectors: pub.sectors, product: pub.product, techStack: pub.techStack, coverImage: pub.coverImage, projectUrls: pub.projectUrls, partnerNames: pub.partnerNames },
        create: { name: [...publicByName.entries()].find(([, v]) => v.publicNotionPageId === pub.publicNotionPageId)![0], publicNotionPageId: pub.publicNotionPageId, description: pub.description, sectors: pub.sectors, product: pub.product, techStack: pub.techStack, coverImage: pub.coverImage, projectUrls: pub.projectUrls, partnerNames: pub.partnerNames, status: ProjectStatus.SHIPPED },
      });
      pubOnly++;
    } catch { /* skip */ }
  }
  if (pubOnly) console.log(`  + ${pubOnly} public-only projects added`);

  console.log(`  ✓ ${ok} projects synced${fail ? `, ${fail} failed` : ""}`);
}

// ─── Step 3: Sync Members ─────────────────────────────────────────────────────

async function syncMembers(
  pages: any[],
  termIdByName: Map<string, string>,
  hiredRolesByMemberPageId: Map<string, Array<{ role: Role; level: Level }>>,
): Promise<void> {
  console.log(`\n── Syncing ${pages.length} members...`);
  const academicYearTerms = getCurrentAcademicYearTerms();

  // Fallback accepted term for new members whose terms haven't been populated
  // in Notion yet — use the most recent term we know about.
  const currentTermName = [...academicYearTerms].filter(t => termIdByName.has(t)).sort().at(-1);
  const fallbackTermId = currentTermName ? termIdByName.get(currentTermName) : undefined;

  // Prefetch all existing members and users in bulk
  const existingMembers = await prisma.member.findMany({
    select: { id: true, notionPageId: true, userId: true, daliEmail: true },
  });
  const existingByNotionId = new Map(existingMembers.map(m => [m.notionPageId!, m]));
  // Track claimed emails in-memory to catch duplicates within this run
  const claimedDaliEmails = new Map<string, string>( // daliEmail → notionPageId
    existingMembers.filter(m => m.daliEmail && !m.daliEmail.startsWith("notion-")).map(m => [m.daliEmail, m.notionPageId!])
  );
  let ok = 0, skipped = 0, failed = 0;

  // Process serially to avoid races on email uniqueness
  for (const page of pages) {
    const props = page.properties;
    const notionPageId: string = page.id;
    const fullName = (props.Name?.title?.[0]?.plain_text || "Unknown").trim();
    const imageUrl: string | null =
      props.profile?.files?.[0]?.file?.url ||
      props.profile?.files?.[0]?.external?.url ||
      props.photo?.files?.[0]?.file?.url ||
      props.photo?.files?.[0]?.external?.url ||
      null;
    const classYear = props.year?.multi_select?.[0]?.name ?? null;
    const { major, minor } = extractMajorMinor(props);
    const linkedinUrl = props.linkedin?.url || props.linkedin?.rich_text?.[0]?.plain_text || null;
    const githubId = props.github?.url?.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\/$/, "") || props.github?.rich_text?.[0]?.plain_text || null;

    const memberTermNames = extractMemberTermNames(props);
    const termIds = memberTermNames.map(t => termIdByName.get(t)).filter((id): id is string => !!id);
    const sortedTermIds = memberTermNames.filter(t => termIdByName.has(t)).sort().map(t => termIdByName.get(t) as string);
    const joinedTermId = sortedTermIds[0] ?? fallbackTermId;

    if (!joinedTermId) { skipped++; continue; }

    const hasCurrentYearTerm = memberTermNames.some(t => academicYearTerms.has(t));
    // New members with no terms yet (using fallback) are active, not alums
    const isAlum = memberTermNames.length > 0 ? !hasCurrentYearTerm : false;
    const hiredRoles = hiredRolesByMemberPageId.get(notionPageId) ?? [];

    // Role display fields
    const coreRoleNames: string[] = (props["core role"]?.multi_select ?? []).map((r: any) => r.name);
    const hiredRoleStrings: string[] = (props["hired roles"]?.multi_select ?? []).map((r: any) => r.name);
    const currentRoleFormula: string = props["Current Role"]?.formula?.string ?? "";
    const currentRole: string | null = currentRoleFormula || null;
    const rolesFromFormula: string[] = currentRoleFormula
      ? currentRoleFormula.split(",").map((s: string) => s.trim()).filter(Boolean)
      : hiredRoleStrings;
    const roles: string[] = [...new Set([...coreRoleNames, ...rolesFromFormula])];

    // Resolve daliEmail — use the value from Notion if present and unclaimed,
    // otherwise fall back to a placeholder. userId is intentionally left null
    // so members can self-link via the account page after logging in.
    const rawDaliEmail = props['dali email']?.email as string | null ?? null;

    const existingMember = existingByNotionId.get(notionPageId);

    const daliEmailOwner = rawDaliEmail ? claimedDaliEmails.get(rawDaliEmail) : null;
    const daliEmailOk = rawDaliEmail && (!daliEmailOwner || daliEmailOwner === notionPageId);
    const daliEmail = daliEmailOk ? rawDaliEmail! : `notion-${notionPageId}@dali`;
    if (daliEmailOk) claimedDaliEmails.set(rawDaliEmail!, notionPageId);

    try {
      const member = await prisma.member.upsert({
        where: { notionPageId },
        update: { fullName, imageUrl, daliEmail, classYear, major, minor, linkedinUrl, githubId, isAlum, isActive: !isAlum, currentRole, roles, coreRoleNames, termsInDali: { set: termIds.map(id => ({ id })) } },
        create: { fullName, imageUrl, daliEmail, joinedTermId, notionPageId, classYear, major, minor, linkedinUrl, githubId, isAlum, isActive: !isAlum, currentRole, roles, coreRoleNames, termsInDali: { connect: termIds.map(id => ({ id })) } },
      });

      // Sync HiredRoles
      await prisma.hiredRole.deleteMany({ where: { memberId: member.id } });
      if (hiredRoles.length) {
        await prisma.hiredRole.createMany({ data: hiredRoles.map(({ role, level }) => ({ memberId: member.id, role, level })) });
      }

      // Update in-memory cache
      existingByNotionId.set(notionPageId, { id: member.id, notionPageId, userId: existingMember?.userId ?? null, daliEmail });
      ok++;
    } catch (err: any) {
      console.error(`  ✗ Member "${fullName}": ${err.message}`);
      failed++;
    }
  }

  console.log(`  ✓ ${ok} members synced, ${skipped} skipped (no terms)${failed ? `, ${failed} failed` : ""}`);
}

// ─── Step 4: Sync Teams + MemberTermRoles (from Project Assignment DB) ────────

async function syncTeamsAndRoles(
  assignmentPages: any[],
  termIdByName: Map<string, string>,
  hiredRolesByMemberPageId: Map<string, Array<{ role: Role; level: Level }>>,
): Promise<void> {
  console.log(`\n── Syncing teams & member-term roles from ${assignmentPages.length} assignments...`);

  // Prefetch projects and members by notionPageId
  const projects = await prisma.project.findMany({ select: { id: true, name: true, notionPageId: true } });
  const projectByNotionId = new Map(projects.filter(p => p.notionPageId).map(p => [p.notionPageId!, p]));

  const members = await prisma.member.findMany({ select: { id: true, notionPageId: true } });
  const memberByNotionId = new Map(members.filter(m => m.notionPageId).map(m => [m.notionPageId!, m]));

  // Parse all assignments — Project relation points directly to Project Cards,
  // which are now the notionPageIds stored in our projects table.
  type Assignment = {
    memberNotionId: string;
    projectNotionId: string;
    termName: string;
    role: Role | null;
  };
  const assignments: Assignment[] = [];
  for (const page of assignmentPages) {
    const props = page.properties;
    const memberNotionId = props["Member Record"]?.relation?.[0]?.id;
    const projectNotionId = props["Project"]?.relation?.[0]?.id;
    const termName = props["Term"]?.select?.name;
    const rawRole = props["_role_string"]?.formula?.string ?? "";
    if (!memberNotionId || !projectNotionId || !termName) continue;
    assignments.push({ memberNotionId, projectNotionId, termName, role: mapNotionRoleToEnum(rawRole) });
  }

  // Sync MemberTermRoles — one record per member+term+project+role combination.
  // The assignment DB gives us member+term+project; hired roles map gives their role(s).
  console.log("  Rebuilding member_term_roles...");
  await prisma.memberTermRole.deleteMany({});
  const mtrSet = new Set<string>();
  const mtrData: { memberId: string; termId: string; projectId: string; role: Role }[] = [];
  for (const a of assignments) {
    const member = memberByNotionId.get(a.memberNotionId);
    const termId = termIdByName.get(a.termName);
    const project = projectByNotionId.get(a.projectNotionId);
    if (!member || !termId || !project) continue;
    const roles = hiredRolesByMemberPageId.get(a.memberNotionId) ?? [];
    for (const { role } of roles) {
      const key = `${member.id}::${termId}::${project.id}::${role}`;
      if (!mtrSet.has(key)) {
        mtrSet.add(key);
        mtrData.push({ memberId: member.id, termId, projectId: project.id, role });
      }
    }
  }
  await prisma.memberTermRole.createMany({ data: mtrData, skipDuplicates: true });
  console.log(`  ✓ ${mtrData.length} member-term roles created`);

  // Sync Teams — group assignments by project+term
  console.log("  Rebuilding teams...");
  const teamMap = new Map<string, { projectNotionId: string; termName: string; memberIds: string[] }>();
  for (const a of assignments) {
    const member = memberByNotionId.get(a.memberNotionId);
    if (!member) continue;
    const key = `${a.projectNotionId}::${a.termName}`;
    if (!teamMap.has(key)) teamMap.set(key, { projectNotionId: a.projectNotionId, termName: a.termName, memberIds: [] });
    teamMap.get(key)!.memberIds.push(member.id);
  }

  let teamOk = 0;
  for (const { projectNotionId, termName, memberIds } of teamMap.values()) {
    const project = projectByNotionId.get(projectNotionId);
    const termId = termIdByName.get(termName);
    if (!project || !termId || memberIds.length === 0) continue;

    const existing = await prisma.team.findFirst({ where: { projectId: project.id, termId } });
    if (existing) {
      await prisma.team.update({ where: { id: existing.id }, data: { members: { set: memberIds.map(id => ({ id })) } } });
    } else {
      await prisma.team.create({ data: { name: `${project.name} ${termName}`, projectId: project.id, termId, members: { connect: memberIds.map(id => ({ id })) } } });
    }
    teamOk++;
  }
  console.log(`  ✓ ${teamOk} teams synced`);
}

// ─── Step 5: Sync Bids ────────────────────────────────────────────────────────

function mapBidPreference(val: string | null | undefined): ProjectPreference {
  if (!val) return ProjectPreference.NONE;
  const v = val.toLowerCase();
  if (v.includes("mentor")) return ProjectPreference.MENTOR;
  if (v.includes("contributor") || v.includes("yes")) return ProjectPreference.CONTRIBUTOR;
  return ProjectPreference.NONE;
}

async function syncBids(
  bidPages: any[],
  termIdByName: Map<string, string>,
  memberIdByNotionId: Map<string, string>,
  projectIdByNotionId: Map<string, string>,
): Promise<void> {
  console.log(`\n── Syncing ${bidPages.length} bids...`);

  const resolveProject = (props: any, key: string): string | null => {
    const ids: string[] = props[key]?.relation?.map((r: any) => r.id) ?? [];
    return ids.map(id => projectIdByNotionId.get(id)).find(Boolean) ?? null;
  };

  let ok = 0, skipped = 0, failed = 0;

  for (const page of bidPages) {
    const props = page.properties;
    const notionPageId: string = page.id;

    const memberNotionIds: string[] = props["DALI Member"]?.relation?.map((r: any) => r.id) ?? [];
    const memberId = memberNotionIds.map(id => memberIdByNotionId.get(id)).find(Boolean);
    if (!memberId) { skipped++; continue; }

    const termName: string = props["Term"]?.select?.name || "26S";
    const termId = termIdByName.get(termName);
    if (!termId) { skipped++; continue; }

    const data = {
      memberId,
      termId,
      projectPref1Id: resolveProject(props, "Project Pref #1"),
      projectPref2Id: resolveProject(props, "Project Pref #2"),
      projectPref3Id: resolveProject(props, "Project Pref #3"),
      assignedProjectId: resolveProject(props, "Assigned Project"),
      preference: mapBidPreference(props["Would you like to be on a project this term?"]?.select?.name),
      hoursPerWeek: props["How many hours a week will you commit to DALI?"]?.select?.name ?? null,
      isMentorThisTerm: props["Are you a mentor in 26W?"]?.select?.name === "Yes",
      isOnCoreThisTerm: props["Are you on core in 26W?"]?.select?.name === "Yes",
      interest: (props["Interest"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim() || null,
      roleQuestion1: (props["Role-Specific Question #1"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim() || null,
      roleQuestion2: (props["Role-Specific Question #2"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim() || null,
      roleQuestion3: (props["Role-Specific Question #3"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim() || null,
      allLabIdea: (props["If you could have any all lab this term, what would it be?"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim() || null,
      preferWith: (props["Is there anyone you would like to be on a project with?"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim() || null,
      preferNotWith: (props["Is there anyone you would not like to be on a project with?"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim() || null,
      otherNotes: (props["Is there anything else you'd like us to know or take into consideration when deciding project assignments?"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim() || null,
      otherInvolvement: props["What else would you be interested in being involved with in the lab?"]?.multi_select?.map((s: any) => s.name) ?? [],
      addedToAssignments: props["Add to Project Assignments DB"]?.checkbox ?? false,
      readyToMigrate: props["Ready to Migrate"]?.formula?.boolean ?? false,
      submittedAt: new Date(page.created_time),
    };

    try {
      await prisma.bid.upsert({
        where: { notionPageId },
        update: data,
        create: { ...data, notionPageId },
      });
      ok++;
    } catch (err: any) {
      console.error(`  ✗ Bid "${notionPageId}": ${err.message}`);
      failed++;
    }
  }

  console.log(`  ✓ ${ok} bids synced, ${skipped} skipped (no member/term match), ${failed} failed`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🔄 Starting Notion → Postgres sync...\n");

  console.log("── Fetching Notion data (in parallel)...");
  const [memberPages, cardPages, trackingPages, hiredRolePages, assignmentPages, bidPages] = await Promise.all([
    queryAll(MEMBERS_DB_ID, { sorts: [{ property: "started time", direction: "ascending" }, { property: "Name", direction: "ascending" }] }),
    queryAll(PROJECT_CARDS_DB_ID, { sorts: [{ property: "Name", direction: "ascending" }] }),
    queryAll(PROJECT_TRACKING_DB_ID, { sorts: [{ property: "Name", direction: "ascending" }] }),
    queryAll(HIRED_ROLES_DB_ID),
    queryAll(PROJECT_ASSIGNMENTS_DB_ID, { sorts: [{ property: "Name", direction: "ascending" }] }),
    queryAll(BIDS_DB_ID),
  ]);

  // Public projects DB is optional — may not be shared with the integration
  const publicPages = await queryAll(PUBLIC_PROJECTS_DB_ID, { filter: { property: "Status", select: { equals: "Published" } } })
    .catch((err: any) => { console.warn(`  ⚠ Public projects DB unavailable (${err.code ?? err.message}) — skipping display fields`); return []; });

  console.log(`  ${memberPages.length} members, ${cardPages.length} project cards, ${trackingPages.length} tracking, ${hiredRolePages.length} hired roles, ${assignmentPages.length} assignments, ${publicPages.length} public projects, ${bidPages.length} bids`);

  // Build hired roles map: member notion page ID → [{role, level}]
  const hiredRolesByMemberPageId = new Map<string, Array<{ role: Role; level: Level }>>();
  for (const page of hiredRolePages) {
    const props = page.properties;
    const role = mapNotionRoleToEnum(props.Name?.title?.[0]?.plain_text ?? "");
    if (!role) continue;
    const level = mapNotionLevelToEnum(props.Level?.select?.name);
    for (const rel of (props["DALI Members"]?.relation ?? [])) {
      const id: string = rel.id;
      if (!hiredRolesByMemberPageId.has(id)) hiredRolesByMemberPageId.set(id, []);
      hiredRolesByMemberPageId.get(id)!.push({ role, level });
    }
  }

  // Collect all term strings
  const termStrings = new Set<string>();
  for (const page of memberPages) {
    for (const t of page.properties["_terms_in_dali"]?.multi_select ?? []) termStrings.add(t.name);
  }
  for (const page of cardPages) {
    for (const t of page.properties["terms"]?.multi_select ?? []) termStrings.add(t.name);
  }
  for (const page of assignmentPages) {
    const t = page.properties["Term"]?.select?.name;
    if (t) termStrings.add(t);
  }
  for (const page of bidPages) {
    const t = page.properties["Term"]?.select?.name || "26S";
    if (t) termStrings.add(t);
  }

  const termIdByName = await syncTerms(termStrings);
  await syncProjects(cardPages, trackingPages, publicPages, termIdByName);
  await syncMembers(memberPages, termIdByName, hiredRolesByMemberPageId);
  await syncTeamsAndRoles(assignmentPages, termIdByName, hiredRolesByMemberPageId);

  // Build lookup maps for bids (members and projects are now in DB)
  const allMembers = await prisma.member.findMany({ select: { id: true, notionPageId: true } });
  const memberIdByNotionId = new Map(allMembers.filter(m => m.notionPageId).map(m => [m.notionPageId!, m.id]));
  const allProjects = await prisma.project.findMany({ select: { id: true, notionPageId: true } });
  const projectIdByNotionId = new Map(allProjects.filter(p => p.notionPageId).map(p => [p.notionPageId!, p.id]));
  await syncBids(bidPages, termIdByName, memberIdByNotionId, projectIdByNotionId);

  console.log("\n✅ Sync complete.");
}

main()
  .catch(err => {
    console.error("\n❌ Sync failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
