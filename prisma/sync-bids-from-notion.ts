/**
 * sync-bids-from-notion.ts
 *
 * Migrates all records from the Notion Bids DB into the `bids` table in dali-db.
 * Matches DALI Member and Project relations via notionPageId.
 * Run: npm run bids:sync
 */

import { Client } from "@notionhq/client";
import { PrismaClient, ProjectPreference } from "../lib/generated/index.js";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const prisma = new PrismaClient();

const BIDS_DB_ID = "2b7fe958d92f80f68100edef8335b46c";

async function queryAll(databaseId: string): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const response: any = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

function richText(val: any[]): string | null {
  return val?.map((t: any) => t.plain_text).join("").trim() || null;
}

function mapPreference(val: string | null | undefined): ProjectPreference {
  if (!val) return ProjectPreference.NONE;
  const v = val.toLowerCase();
  if (v.includes("mentor")) return ProjectPreference.MENTOR;
  if (v.includes("contributor") || v.includes("yes")) return ProjectPreference.CONTRIBUTOR;
  return ProjectPreference.NONE;
}

async function main() {
  console.log("── Fetching Bids from Notion...");
  const pages = await queryAll(BIDS_DB_ID);
  console.log(`  ${pages.length} bid records found`);

  // Build lookup maps: Notion page ID → DB ID
  const members = await prisma.member.findMany({ select: { id: true, notionPageId: true } });
  const memberByNotionId = new Map(members.filter(m => m.notionPageId).map(m => [m.notionPageId!, m.id]));

  const projects = await prisma.project.findMany({ select: { id: true, notionPageId: true, publicNotionPageId: true } });
  const projectByNotionId = new Map<string, string>();
  for (const p of projects) {
    if (p.notionPageId) projectByNotionId.set(p.notionPageId, p.id);
    if (p.publicNotionPageId) projectByNotionId.set(p.publicNotionPageId, p.id);
  }

  const terms = await prisma.term.findMany({ select: { id: true, name: true } });
  const termByName = new Map(terms.map(t => [t.name, t.id]));

  let ok = 0, skipped = 0, failed = 0;

  for (const page of pages) {
    const props = page.properties;
    const notionPageId: string = page.id;

    const memberNotionIds: string[] = props["DALI Member"]?.relation?.map((r: any) => r.id) ?? [];
    const memberId = memberNotionIds.map((id: string) => memberByNotionId.get(id)).find(Boolean);
    if (!memberId) {
      const name = props.Name?.title?.[0]?.plain_text ?? "?";
      console.warn(`  skip (no member match): ${name} — notion ids: ${memberNotionIds.join(", ")}`);
      skipped++; continue;
    }

    // Default to 26S — all records in this DB are for 26S (term field is often blank)
    const termName: string = props["Term"]?.select?.name || "26S";
    const termId = termByName.get(termName);
    if (!termId) {
      const name = props.Name?.title?.[0]?.plain_text ?? "?";
      console.warn(`  skip (no term match): ${name} — term: "${termName}"`);
      skipped++; continue;
    }

    const resolveProject = (key: string) => {
      const ids: string[] = props[key]?.relation?.map((r: any) => r.id) ?? [];
      const resolved = ids.map((id: string) => projectByNotionId.get(id)).find(Boolean) ?? null;
      if (ids.length > 0 && !resolved) {
        const name = props.Name?.title?.[0]?.plain_text ?? "?";
        console.warn(`  warn (no project match for ${key}): ${name} — notion ids: ${ids.join(", ")}`);
      }
      return resolved;
    };

    const data = {
      memberId,
      termId,
      projectPref1Id: resolveProject("Project Pref #1"),
      projectPref2Id: resolveProject("Project Pref #2"),
      projectPref3Id: resolveProject("Project Pref #3"),
      rolePref1: richText(props["Role Pref #1"]?.rich_text ?? []) ?? props["Role Pref #1"]?.select?.name ?? null,
      rolePref2: richText(props["Role Pref #2"]?.rich_text ?? []) ?? props["Role Pref #2"]?.select?.name ?? null,
      rolePref3: richText(props["Role Pref #3"]?.rich_text ?? []) ?? props["Role Pref #3"]?.select?.name ?? null,
      assignedProjectId: resolveProject("Assigned Project"),
      assignedRole: props["Assigned Role"]?.relation?.[0]
        ? null // role is a relation — name not directly available, skip for now
        : null,
      preference: mapPreference(props["Would you like to be on a project this term?"]?.select?.name),
      hoursPerWeek: props["How many hours a week will you commit to DALI?"]?.select?.name ?? null,
      isMentorThisTerm: props["Are you a mentor in 26W?"]?.select?.name === "Yes",
      isOnCoreThisTerm: props["Are you on core in 26W?"]?.select?.name === "Yes",
      interest: richText(props["Interest"]?.rich_text ?? []),
      roleQuestion1: richText(props["Role-Specific Question #1"]?.rich_text ?? []),
      roleQuestion2: richText(props["Role-Specific Question #2"]?.rich_text ?? []),
      roleQuestion3: richText(props["Role-Specific Question #3"]?.rich_text ?? []),
      workshopInterest: richText(props["What workshop would you be interested in leading and/or creating? For ideas, consider looking through the workshops archive. You may pitch a novel topic or re-use and adapt an existing one. Please describe the idea(s), including potential content themes, activities, assignments, etc."]?.rich_text ?? []),
      instructorReason: richText(props["Why are you interested in becoming an \"Instructor,\" and what makes you well-suited for the position?"]?.rich_text ?? []),
      allLabIdea: richText(props["If you could have any all lab this term, what would it be?"]?.rich_text ?? []),
      preferWith: richText(props["Is there anyone you would like to be on a project with?"]?.rich_text ?? []),
      preferNotWith: richText(props["Is there anyone you would not like to be on a project with?"]?.rich_text ?? []),
      otherNotes: richText(props["Is there anything else you'd like us to know or take into consideration when deciding project assignments?"]?.rich_text ?? []),
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

  console.log(`✅ Bids sync complete: ${ok} upserted, ${skipped} skipped (no member/term match), ${failed} failed`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
