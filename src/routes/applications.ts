import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

// GET /applications?userId=
router.get("/", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "userId query param required" });
    }

    const applications = await prisma.application.findMany({
      where: { userId },
      include: { term: true },
      orderBy: { submittedAt: "desc" },
    });

    res.json(applications);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /applications/:id
router.get("/:id", async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: { term: true, user: { select: { id: true, firstName: true, lastName: true, dartmouthEmail: true } } },
    });
    if (!application) return res.status(404).json({ error: "Application not found" });
    res.json(application);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /applications
// Body: { userId, termId, rolesApplied, portfolioUrl?, resumeUrl?, statement? }
router.post("/", async (req, res) => {
  try {
    const { userId, termId, rolesApplied, portfolioUrl, resumeUrl, statement } = req.body;

    if (!userId || !termId) {
      return res.status(400).json({ error: "userId and termId are required" });
    }

    // Prevent duplicate pending/under_review application for same term
    const existing = await prisma.application.findFirst({
      where: {
        userId,
        termId,
        status: { in: ["PENDING", "UNDER_REVIEW"] },
      },
    });
    if (existing) {
      return res.status(409).json({ error: "An active application for this term already exists" });
    }

    const application = await prisma.application.create({
      data: {
        userId,
        termId,
        rolesApplied: rolesApplied ?? [],
        portfolioUrl,
        resumeUrl,
        statement,
      },
      include: { term: true },
    });

    res.status(201).json(application);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /applications/:id/status — for reviewers to update status + notes
router.patch("/:id/status", async (req, res) => {
  try {
    const { status, reviewerNotes } = req.body;
    const application = await prisma.application.update({
      where: { id: req.params.id },
      data: {
        ...(status && { status }),
        ...(reviewerNotes !== undefined && { reviewerNotes }),
      },
      include: { term: true },
    });
    res.json(application);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Application not found" });
    res.status(500).json({ error: err.message });
  }
});

export default router;
