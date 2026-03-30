import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { ProjectStatus } from "../../lib/generated/index.js";
import { Client } from "@notionhq/client";

const router = Router();

function memberName(m: { fullName: string | null; user: { firstName: string | null; lastName: string | null } | null }): string | null {
  return m.fullName ?? (m.user ? `${m.user.firstName ?? ""} ${m.user.lastName ?? ""}`.trim() || null : null);
}

// GET /projects?term=25W&status=ACTIVE
router.get("/", async (req, res) => {
  try {
    const { term, status, public: publicOnly } = req.query;

    const projects = await prisma.project.findMany({
      where: {
        ...(status && { status: String(status) as ProjectStatus }),
        ...(term && { termsInDali: { some: { name: String(term) } } }),
        ...(publicOnly === "true" && { isPublic: true }),
      },
      include: {
        termsInDali: { select: { name: true } },
        teams: {
          include: {
            term: { select: { name: true } },
            members: { select: { fullName: true, user: { select: { firstName: true, lastName: true } } } },
          },
          orderBy: { term: { startDate: "asc" } },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
    });

    const shaped = projects.map(p => {
      // All unique members across all terms (for backwards compat)
      const teamMembers = [
        ...new Set(p.teams.flatMap(t => t.members.map(memberName).filter((n): n is string => !!n))),
      ];
      // Teams grouped by term
      const teamsByTerm: { term: string; members: string[] }[] = p.teams.map(t => ({
        term: t.term.name,
        members: t.members.map(memberName).filter((n): n is string => !!n),
      }));
      const term = p.termsInDali.at(-1)?.name ?? "";

      return {
        id: p.id,
        name: p.name,
        description: p.description ?? "",
        status: p.status,
        tags: [...p.sectors, ...p.product, ...p.techStack],
        sector: p.sectors[0] ?? undefined,
        sectors: p.sectors,
        product: p.product,
        techStack: p.techStack,
        term,
        teamMembers,
        teamsByTerm,
        coverImage: p.coverImage ?? "",
        projectUrls: p.projectUrls as Array<{ label: string; url: string }>,
        partnerNames: p.partnerNames,
        notionPageId: p.notionPageId,
        publicNotionPageId: p.publicNotionPageId,
        slackChannelId: p.slackChannelId,
        githubTeamSlug: p.githubTeamSlug,
        isPublic: p.isPublic,
      };
    });

    res.json({ projects: shaped });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /projects/:id/content — fetch Notion page blocks for a project
router.get("/:id/content", async (req, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { publicNotionPageId: true },
    });

    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.publicNotionPageId) return res.json({ pageContent: [] });

    const notion = new Client({ auth: process.env.NOTION_TOKEN });
    const blocks: any[] = [];
    let cursor: string | undefined;

    do {
      const response: any = await notion.blocks.children.list({
        block_id: project.publicNotionPageId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      blocks.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    res.json({ pageContent: blocks });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /projects/:id
router.get("/:id", async (req, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        termsInDali: { select: { name: true } },
        repos: true,
        teams: {
          include: {
            term: { select: { name: true } },
            members: {
              select: {
                id: true,
                fullName: true,
                imageUrl: true,
                roles: true,
                hiredRoles: { select: { role: true, level: true } },
                user: { select: { firstName: true, lastName: true, picture: true } },
              },
            },
          },
          orderBy: { term: { startDate: "asc" } },
        },
      },
    });

    if (!project) return res.status(404).json({ error: "Project not found" });

    const teamMembers = [
      ...new Set(project.teams.flatMap(t => t.members.map(memberName).filter((n): n is string => !!n))),
    ];
    const teamsByTerm: { term: string; members: string[] }[] = project.teams.map(t => ({
      term: t.term.name,
      members: t.members.map(memberName).filter((n): n is string => !!n),
    }));

    res.json({
      ...project,
      tags: [...project.sectors, ...project.product, ...project.techStack],
      sector: project.sectors[0] ?? undefined,
      term: project.termsInDali.at(-1)?.name ?? "",
      teamMembers,
      teamsByTerm,
      projectUrls: project.projectUrls as Array<{ label: string; url: string }>,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /projects
router.post("/", async (req, res) => {
  try {
    const { name, status, term: termName } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });

    const created = await prisma.project.create({
      data: {
        name: name.trim(),
        status: (status as ProjectStatus) ?? "ACTIVE",
        ...(termName && {
          termsInDali: {
            connect: [{ name: String(termName) }],
          },
        }),
      },
      include: {
        termsInDali: { select: { name: true } },
        repos: true,
        teams: {
          include: {
            term: { select: { name: true } },
            members: { select: { fullName: true, user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    });

    res.status(201).json({
      id: created.id,
      name: created.name,
      description: created.description ?? "",
      status: created.status,
      tags: [],
      sectors: [],
      product: [],
      techStack: [],
      term: created.termsInDali.at(-1)?.name ?? "",
      teamMembers: [],
      teamsByTerm: [],
      coverImage: "",
      projectUrls: [],
      partnerNames: [],
      repos: created.repos,
      notionPageId: created.notionPageId,
      publicNotionPageId: created.publicNotionPageId,
      slackChannelId: created.slackChannelId,
      githubTeamSlug: created.githubTeamSlug,
      isPublic: created.isPublic,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /projects/:id
router.patch("/:id", async (req, res) => {
  try {
    const { name, status, isPublic, description, coverImage, publicNotionPageId, slackChannelId, githubTeamSlug, projectUrls, sectors, product, techStack, partnerNames } = req.body;

    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!project) return res.status(404).json({ error: "Project not found" });

    const updated = await prisma.project.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(status !== undefined && { status: status as ProjectStatus }),
        ...(isPublic !== undefined && { isPublic }),
        ...(description !== undefined && { description }),
        ...(coverImage !== undefined && { coverImage: coverImage || null }),
        ...(publicNotionPageId !== undefined && { publicNotionPageId: publicNotionPageId || null }),
        ...(slackChannelId !== undefined && { slackChannelId: slackChannelId || null }),
        ...(githubTeamSlug !== undefined && { githubTeamSlug: githubTeamSlug || null }),
        ...(projectUrls !== undefined && { projectUrls }),
        ...(sectors !== undefined && { sectors }),
        ...(product !== undefined && { product }),
        ...(techStack !== undefined && { techStack }),
        ...(partnerNames !== undefined && { partnerNames }),
      },
      include: {
        termsInDali: { select: { name: true } },
        repos: true,
        teams: {
          include: {
            term: { select: { name: true } },
            members: { select: { fullName: true, user: { select: { firstName: true, lastName: true } } } },
          },
          orderBy: { term: { startDate: "asc" } },
        },
      },
    });

    const teamMembers = [
      ...new Set(updated.teams.flatMap(t => t.members.map(memberName).filter((n): n is string => !!n))),
    ];
    const teamsByTerm = updated.teams.map(t => ({
      term: t.term.name,
      members: t.members.map(memberName).filter((n): n is string => !!n),
    }));

    res.json({
      id: updated.id,
      name: updated.name,
      description: updated.description ?? "",
      status: updated.status,
      tags: [...updated.sectors, ...updated.product, ...updated.techStack],
      sectors: updated.sectors,
      product: updated.product,
      techStack: updated.techStack,
      term: updated.termsInDali.at(-1)?.name ?? "",
      teamMembers,
      teamsByTerm,
      coverImage: updated.coverImage ?? "",
      projectUrls: updated.projectUrls as Array<{ label: string; url: string }>,
      partnerNames: updated.partnerNames,
      repos: updated.repos,
      notionPageId: updated.notionPageId,
      publicNotionPageId: updated.publicNotionPageId,
      slackChannelId: updated.slackChannelId,
      githubTeamSlug: updated.githubTeamSlug,
      isPublic: updated.isPublic,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /projects/:id/repos
router.post("/:id/repos", async (req, res) => {
  try {
    const { type, url } = req.body;
    if (!type || !url) return res.status(400).json({ error: "type and url are required" });
    const repo = await prisma.repo.create({ data: { projectId: req.params.id, type, url } });
    res.status(201).json(repo);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /projects/:id/repos/:repoId
// DELETE /projects/:id
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.memberTermRole.deleteMany({ where: { projectId: id } }),
      prisma.team.deleteMany({ where: { projectId: id } }),
      prisma.bid.updateMany({ where: { projectPref1Id: id }, data: { projectPref1Id: null } }),
      prisma.bid.updateMany({ where: { projectPref2Id: id }, data: { projectPref2Id: null } }),
      prisma.bid.updateMany({ where: { projectPref3Id: id }, data: { projectPref3Id: null } }),
      prisma.bid.updateMany({ where: { assignedProjectId: id }, data: { assignedProjectId: null, assignedRole: null } }),
      prisma.project.delete({ where: { id } }),
    ]);
    res.status(204).send();
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Project not found" });
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id/repos/:repoId", async (req, res) => {
  try {
    await prisma.repo.delete({ where: { id: req.params.repoId } });
    res.status(204).send();
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Repo not found" });
    res.status(500).json({ error: err.message });
  }
});

export default router;
