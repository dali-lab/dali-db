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

// GET /terms/current
router.get("/current", async (_req, res) => {
  try {
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

export default router;
