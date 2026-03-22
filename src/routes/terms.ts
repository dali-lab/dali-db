import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

// GET /terms
router.get("/", async (_req, res) => {
  try {
    const terms = await prisma.term.findMany({ orderBy: { startDate: "desc" } });
    res.json(terms);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /terms/current — prefers `isCurrent`, else the term whose date range contains today
router.get("/current", async (_req, res) => {
  try {
    const flagged = await prisma.term.findFirst({ where: { isCurrent: true } });
    if (flagged) {
      res.json(flagged);
      return;
    }
    const now = new Date();
    const term = await prisma.term.findFirst({
      where: { startDate: { lte: now }, endDate: { gte: now } },
    });
    if (!term) return res.status(404).json({ error: "No current term found" });
    res.json(term);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /terms/:name (e.g. /terms/25W)
router.get("/:name", async (req, res) => {
  try {
    const term = await prisma.term.findUnique({
      where: { name: req.params.name },
      include: { projects: { select: { id: true, name: true, status: true } } },
    });
    if (!term) return res.status(404).json({ error: "Term not found" });
    res.json(term);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /terms
router.post("/", async (req, res) => {
  try {
    const { name, startDate, endDate } = req.body;
    if (!name || !startDate || !endDate) {
      return res.status(400).json({ error: "name, startDate, and endDate are required" });
    }
    const term = await prisma.term.create({
      data: { name, startDate: new Date(startDate), endDate: new Date(endDate) },
    });
    res.status(201).json(term);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /terms/set-current — sets `isCurrent` on one term (clears others). Drives GET /terms/current.
router.post("/set-current", async (req, res) => {
  try {
    const name = req.body?.name as string | undefined;
    if (!name) return res.status(400).json({ error: "name is required" });
    const existing = await prisma.term.findUnique({ where: { name } });
    if (!existing) return res.status(404).json({ error: "Term not found" });
    await prisma.$transaction([
      prisma.term.updateMany({ data: { isCurrent: false } }),
      prisma.term.update({ where: { name }, data: { isCurrent: true } }),
    ]);
    const term = await prisma.term.findUnique({ where: { name } });
    res.json(term);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
