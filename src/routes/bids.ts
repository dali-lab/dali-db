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
      },
      orderBy: { submittedAt: "asc" },
    });

    res.json({ bids });
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
    const { assignedProjectId, assignedRole, readyToMigrate, addedToAssignments } = req.body;

    const bid = await prisma.bid.update({
      where: { id: req.params.id },
      data: { assignedProjectId, assignedRole, readyToMigrate, addedToAssignments },
      include: {
        member: { select: { id: true, fullName: true, daliEmail: true } },
        term: { select: { name: true } },
        assignedProject: { select: { id: true, name: true } },
      },
    });

    res.json(bid);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Bid not found" });
    res.status(500).json({ error: err.message });
  }
});

export default router;
