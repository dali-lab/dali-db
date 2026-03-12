import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { ProjectStatus } from "../../lib/generated/index.js";

const router = Router();

// GET /projects?term=25W&status=ACTIVE
router.get("/", async (req, res) => {
  try {
    const { term, status } = req.query;

    const projects = await prisma.project.findMany({
      where: {
        ...(status && { status: String(status) as ProjectStatus }),
        ...(term && {
          termsInDali: { some: { name: String(term) } },
        }),
      },
      include: {
        termsInDali: true,
        teams: { include: { members: { include: { user: { select: { firstName: true, lastName: true } } } } } },
      },
    });

    res.json(projects);
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
        termsInDali: true,
        teams: { include: { members: { include: { user: { select: { firstName: true, lastName: true, picture: true } }, hiredRoles: true } } } },
        memberTermRoles: { include: { member: { include: { user: { select: { firstName: true, lastName: true } } } }, term: true } },
      },
    });

    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
