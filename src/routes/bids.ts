import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

// GET /bids?term=26S&memberId=...
router.get("/", async (req, res) => {
  try {
    const { term, memberId } = req.query;

    const bids = await prisma.bid.findMany({
      where: {
        ...(term && { term: { name: String(term) } }),
        ...(memberId && { memberId: String(memberId) }),
      },
      include: {
        member: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true, hiredRoles: { select: { role: true, level: true } } } },
        term: { select: { name: true } },
        projectPref1: { select: { id: true, name: true } },
        projectPref2: { select: { id: true, name: true } },
        projectPref3: { select: { id: true, name: true } },
        assignedProject: { select: { id: true, name: true } },
        mentor: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true } },
      },
      orderBy: { submittedAt: "asc" },
    });

    res.json({ bids });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /bids/check-team?projectId=...&term=... — check if a team already exists for this project+term
router.get("/check-team", async (req, res) => {
  try {
    const { projectId, term: termName } = req.query;
    if (!projectId || !termName) return res.status(400).json({ error: "projectId and term are required" });

    const term = await prisma.term.findUnique({ where: { name: String(termName) } });
    if (!term) return res.json({ exists: false });

    const team = await prisma.team.findFirst({
      where: { projectId: String(projectId), termId: term.id },
      include: { members: { select: { id: true, fullName: true } } },
    });

    res.json({
      exists: !!team,
      memberCount: team?.members.length ?? 0,
      members: team?.members.map(m => m.fullName ?? m.id) ?? [],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /bids/:id
router.get("/:id", async (req, res) => {
  try {
    const bid = await prisma.bid.findUnique({
      where: { id: req.params.id },
      include: {
        member: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true } },
        term: { select: { name: true } },
        projectPref1: { select: { id: true, name: true } },
        projectPref2: { select: { id: true, name: true } },
        projectPref3: { select: { id: true, name: true } },
        assignedProject: { select: { id: true, name: true } },
      },
    });

    if (!bid) return res.status(404).json({ error: "Bid not found" });
    res.json(bid);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /bids/:id
router.patch("/:id", async (req, res) => {
  try {
    const { assignedProjectId, assignedRole, readyToMigrate, addedToAssignments, mentorOptOut, mentorId, externalMentor } = req.body;

    const bid = await prisma.bid.update({
      where: { id: req.params.id },
      data: {
        assignedProjectId,
        assignedRole,
        readyToMigrate,
        addedToAssignments,
        ...(mentorOptOut !== undefined && { mentorOptOut: mentorOptOut ?? null }),
        ...(mentorId !== undefined && { mentorId: mentorId ?? null }),
        ...(externalMentor !== undefined && { externalMentor: externalMentor ?? null }),
      },
      include: {
        member: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true, hiredRoles: { select: { role: true, level: true } } } },
        term: { select: { name: true } },
        assignedProject: { select: { id: true, name: true } },
        mentor: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true } },
      },
    });

    res.json(bid);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Bid not found" });
    res.status(500).json({ error: err.message });
  }
});

// POST /bids/publish — finalize assignments for a project+term
// Creates/upserts Team, sets members, creates MemberTermRole entries, sets project ACTIVE,
// marks bids addedToAssignments=true
router.post("/publish", async (req, res) => {
  try {
    const { projectId, term: termName } = req.body;
    if (!projectId || !termName) return res.status(400).json({ error: "projectId and term are required" });

    const VALID_ROLES = ["FULLSTACK", "DATA", "ENGINES", "AR_VR", "UI_UX", "VIDEO", "INSTRUCTOR", "PM"] as const;
    type RoleType = typeof VALID_ROLES[number];

    // Resolve term
    const term = await prisma.term.findUnique({ where: { name: String(termName) } });
    if (!term) return res.status(404).json({ error: `Term "${termName}" not found` });

    // Get all assigned bids for this project+term
    const assignedBids = await prisma.bid.findMany({
      where: { assignedProjectId: projectId, termId: term.id },
      include: { member: { select: { id: true, fullName: true } } },
    });

    if (assignedBids.length === 0) return res.status(400).json({ error: "No assigned bids for this project and term" });

    const memberIds = assignedBids.map(b => b.memberId);

    // Upsert Team (find existing or create)
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    if (!project) return res.status(404).json({ error: "Project not found" });

    let team = await prisma.team.findFirst({ where: { projectId, termId: term.id } });
    if (team) {
      // Update members: set to current assigned set
      team = await prisma.team.update({
        where: { id: team.id },
        data: { members: { set: memberIds.map(id => ({ id })) } },
      });
    } else {
      team = await prisma.team.create({
        data: {
          name: project.name,
          projectId,
          termId: term.id,
          members: { connect: memberIds.map(id => ({ id })) },
        },
      });
    }

    // Upsert MemberTermRole for each bid with a valid assignedRole
    for (const bid of assignedBids) {
      const role = bid.assignedRole?.toUpperCase() as RoleType | undefined;
      if (!role || !VALID_ROLES.includes(role)) continue;
      await prisma.memberTermRole.upsert({
        where: { memberId_termId_projectId_role: { memberId: bid.memberId, termId: term.id, projectId, role } },
        update: {},
        create: { memberId: bid.memberId, termId: term.id, projectId, role },
      });
    }

    // Set project status to ACTIVE
    await prisma.project.update({ where: { id: projectId }, data: { status: "ACTIVE" } });

    // Mark bids addedToAssignments=true
    await prisma.bid.updateMany({
      where: { assignedProjectId: projectId, termId: term.id },
      data: { addedToAssignments: true },
    });

    res.json({ teamId: team.id, memberCount: memberIds.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bids
router.post("/", async (req, res) => {
  try {
    const { memberId, termId, rolePref1, hoursPerWeek } = req.body;
    if (!memberId || !termId) return res.status(400).json({ error: "memberId and termId are required" });

    const bid = await prisma.bid.create({
      data: { memberId, termId, rolePref1, hoursPerWeek },
      include: {
        member: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true, hiredRoles: { select: { role: true, level: true } } } },
        term: { select: { name: true } },
        projectPref1: { select: { id: true, name: true } },
        projectPref2: { select: { id: true, name: true } },
        projectPref3: { select: { id: true, name: true } },
        assignedProject: { select: { id: true, name: true } },
      },
    });

    res.status(201).json(bid);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bids/notify-slack — Create/find a project Slack channel, add assigned members, post team announcement
router.post("/notify-slack", async (req, res) => {
  try {
    const { projectId, term: termName, channelName: channelNameOverride } = req.body;
    if (!projectId || !termName) return res.status(400).json({ error: "projectId and term are required" });

    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken || botToken.startsWith("xoxb-your")) {
      return res.status(503).json({ error: "SLACK_BOT_TOKEN is not configured" });
    }

    const term = await prisma.term.findUnique({ where: { name: String(termName) } });
    if (!term) return res.status(404).json({ error: `Term "${termName}" not found` });

    const assignedBids = await prisma.bid.findMany({
      where: { assignedProjectId: projectId, termId: term.id },
      include: {
        member: { select: { id: true, fullName: true, daliEmail: true } },
        assignedProject: { select: { id: true, name: true, slackChannelId: true } },
      },
    });

    if (assignedBids.length === 0) return res.status(400).json({ error: "No assigned bids for this project and term" });

    const project = assignedBids[0].assignedProject!;
    const projectName = project.name;

    async function slackPost<T extends object = { ok: boolean; [k: string]: any }>(path: string, body: object): Promise<T & { ok: boolean; error?: string }> {
      const r = await fetch(`https://slack.com/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${botToken}` },
        body: JSON.stringify(body),
      });
      return r.json() as Promise<T & { ok: boolean; error?: string }>;
    }

    async function slackGet<T extends object = { ok: boolean; [k: string]: any }>(path: string, params: Record<string, string>): Promise<T & { ok: boolean; error?: string }> {
      const qs = new URLSearchParams(params).toString();
      const r = await fetch(`https://slack.com/api/${path}?${qs}`, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      return r.json() as Promise<T & { ok: boolean; error?: string }>;
    }

    // ── 1. Resolve Slack user IDs for all assigned members ──────────────────
    const memberSlackIds: { memberId: string; name: string; slackUserId: string; role: string }[] = [];
    const results: { member: string; status: "ok" | "no_slack_user" | "error"; error?: string }[] = [];

    for (const bid of assignedBids) {
      const email = bid.member?.daliEmail;
      const name = bid.member?.fullName ?? email ?? bid.memberId;
      const role = bid.assignedRole ?? "Member";

      if (!email) {
        results.push({ member: name, status: "no_slack_user", error: "No email on record" });
        continue;
      }

      const lookup = await slackGet<{ user?: { id: string } }>("users.lookupByEmail", { email });
      console.log(`[notify-slack] lookup ${email}: ok=${lookup.ok} error=${lookup.error} userId=${lookup.user?.id}`);
      if (!lookup.ok || !lookup.user?.id) {
        results.push({ member: name, status: "no_slack_user", error: lookup.error ?? "User not found" });
        continue;
      }

      memberSlackIds.push({ memberId: bid.memberId, name, slackUserId: lookup.user.id, role });
    }

    // ── 2. Create or find the project channel ────────────────────────────────
    // Only treat as a valid ID if it looks like a Slack channel ID (starts with C)
    let channelId: string = /^C[A-Z0-9]+$/i.test(project.slackChannelId ?? "") ? project.slackChannelId! : "";

    // Channel name: only used if we don't already have a stored ID
    const rawName = channelNameOverride?.trim() || projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    // Sanitize: lowercase, replace invalid chars with hyphens, trim hyphens
    const channelName = rawName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

    if (!channelId) {
      // Try to create the channel
      const create = await slackPost<{ channel?: { id: string } }>("conversations.create", {
        name: channelName,
        is_private: false,
      });

      if (create.ok && create.channel?.id) {
        channelId = create.channel.id;
      } else if (create.error === "name_taken") {
        // Channel already exists — join it to get the ID
        const join = await slackPost<{ channel?: { id: string } }>("conversations.join", { channel: channelName });
        if (join.ok && join.channel?.id) channelId = join.channel.id;
      }

      if (!channelId) {
        return res.status(500).json({ error: `Could not create or find Slack channel "${channelName}"` });
      }

      // Persist the real Slack channel ID
      await prisma.project.update({ where: { id: projectId }, data: { slackChannelId: channelId } });
    }

    // ── 3. Add members who aren't already in the channel ────────────────────
    console.log(`[notify-slack] channelId=${channelId} channelName=${channelName} members=${memberSlackIds.map(m => m.slackUserId).join(",")}`);
    for (const m of memberSlackIds) {
      const invite = await slackPost("conversations.invite", {
        channel: channelId,
        users: m.slackUserId,
      });
      console.log(`[notify-slack] invite ${m.name} (${m.slackUserId}): ok=${invite.ok} error=${invite.error}`);
      // already_in_channel is fine — member is present
      if (!invite.ok && invite.error !== "already_in_channel") {
        results.push({ member: m.name, status: "error", error: invite.error });
        continue;
      }
      results.push({ member: m.name, status: "ok" });
    }

    // ── 4. Post team announcement in the channel ─────────────────────────────
    const successfulMembers = memberSlackIds.filter(m => results.find(r => r.member === m.name && r.status === "ok"));

    if (successfulMembers.length > 0) {
      const roster = successfulMembers
        .map(m => `• <@${m.slackUserId}> — ${m.role}`)
        .join("\n");

      const announcement = `Welcome to *${projectName}* for *${termName}*!\n\nHere's your team:\n${roster}\n\nExcited to work together this term! 🚀`;

      const msgResult = await slackPost("chat.postMessage", { channel: channelId, text: announcement });
      if (!msgResult.ok) {
        console.error(`chat.postMessage failed: ${msgResult.error}`);
        results.push({ member: "announcement", status: "error", error: msgResult.error });
      }
    }

    const sent = results.filter(r => r.status === "ok").length;
    const total = assignedBids.length;
    const firstFailure = results.find(r => r.status !== "ok");
    res.json({ sent, total, channelId, channelName, results, firstFailure });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bids/update-github — Create/find a GitHub team in the DALI org and sync assigned members
router.post("/update-github", async (req, res) => {
  try {
    const { projectId, term: termName } = req.body;
    if (!projectId || !termName) return res.status(400).json({ error: "projectId and term are required" });

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken || githubToken.startsWith("ghp_your")) {
      return res.status(503).json({ error: "GITHUB_TOKEN is not configured" });
    }

    const GITHUB_ORG = process.env.GITHUB_ORG ?? "dali-lab";

    const term = await prisma.term.findUnique({ where: { name: String(termName) } });
    if (!term) return res.status(404).json({ error: `Term "${termName}" not found` });

    const assignedBids = await prisma.bid.findMany({
      where: { assignedProjectId: projectId, termId: term.id },
      include: {
        member: { select: { id: true, fullName: true, githubId: true } },
        assignedProject: { select: { id: true, name: true, githubTeamSlug: true } },
      },
    });

    if (assignedBids.length === 0) return res.status(400).json({ error: "No assigned bids for this project and term" });

    const project = assignedBids[0].assignedProject!;
    const projectName = project.name;

    async function ghFetch<T = any>(path: string, method = "GET", body?: object): Promise<{ data?: T; status: number; error?: string }> {
      const r = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await r.text();
      let data: T | undefined;
      try { data = JSON.parse(text); } catch { /* non-JSON response */ }
      return { data, status: r.status };
    }

    // ── 1. Create or find the GitHub team ────────────────────────────────────
    // Team slug: <project-slug> e.g. my-project (shared across terms)
    const teamSlug = project.githubTeamSlug
      ?? projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const teamName = projectName;

    // Check if team exists
    const existing = await ghFetch(`/orgs/${GITHUB_ORG}/teams/${teamSlug}`);
    let resolvedSlug = teamSlug;

    if (existing.status === 404) {
      // Create team
      const created = await ghFetch<{ slug: string }>(`/orgs/${GITHUB_ORG}/teams`, "POST", {
        name: teamName,
        description: `DALI ${projectName} team for ${termName}`,
        privacy: "closed",
      });
      if (created.status !== 201 || !created.data?.slug) {
        return res.status(500).json({ error: `Failed to create GitHub team "${teamName}"` });
      }
      resolvedSlug = created.data.slug;
    } else if (existing.status !== 200) {
      return res.status(500).json({ error: `GitHub API error checking team: ${existing.status}` });
    }

    // Persist slug
    if (!project.githubTeamSlug) {
      await prisma.project.update({ where: { id: projectId }, data: { githubTeamSlug: resolvedSlug } });
    }

    // ── 2. Add members with a githubId to the team ───────────────────────────
    const results: { member: string; status: "added" | "no_github_id" | "error"; error?: string }[] = [];

    for (const bid of assignedBids) {
      const name = bid.member?.fullName ?? bid.memberId;
      const githubId = bid.member?.githubId;

      if (!githubId) {
        results.push({ member: name, status: "no_github_id" });
        continue;
      }

      const add = await ghFetch(`/orgs/${GITHUB_ORG}/teams/${resolvedSlug}/memberships/${githubId}`, "PUT", { role: "member" });
      if (add.status === 200 || add.status === 201) {
        results.push({ member: name, status: "added" });
      } else {
        results.push({ member: name, status: "error", error: `HTTP ${add.status}` });
      }
    }

    const updated = results.filter(r => r.status === "added").length;
    res.json({ updated, total: results.length, teamSlug: resolvedSlug, results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /bids/:id
router.delete("/:id", async (req, res) => {
  try {
    await prisma.bid.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Bid not found" });
    res.status(500).json({ error: err.message });
  }
});

export default router;
