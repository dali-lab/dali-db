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
        ...(publicOnly === "true" && { publicNotionPageId: { not: null } }),
      },
      include: {
        termsInDali: { select: { name: true } },
        teams: {
          include: {
            members: { select: { fullName: true, user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
    });

    const shaped = projects.map(p => {
      const teamMembers = [
        ...new Set(p.teams.flatMap(t => t.members.map(memberName).filter((n): n is string => !!n))),
      ];
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
        coverImage: p.coverImage ?? "",
        projectUrls: p.projectUrls as Array<{ label: string; url: string }>,
        partnerNames: p.partnerNames,
        notionPageId: p.notionPageId,
        publicNotionPageId: p.publicNotionPageId,
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
        },
      },
    });

    if (!project) return res.status(404).json({ error: "Project not found" });

    const teamMembers = [
      ...new Set(project.teams.flatMap(t => t.members.map(memberName).filter((n): n is string => !!n))),
    ];

    res.json({
      ...project,
      tags: [...project.sectors, ...project.product, ...project.techStack],
      sector: project.sectors[0] ?? undefined,
      term: project.termsInDali.at(-1)?.name ?? "",
      teamMembers,
      projectUrls: project.projectUrls as Array<{ label: string; url: string }>,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
