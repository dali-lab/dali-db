import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

// GET /partners
router.get("/", async (_req, res) => {
  try {
    const partners = await prisma.partner.findMany({
      include: { projects: { include: { repos: true, termsInDali: true } } },
    });
    res.json(partners);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /partners/:id
router.get("/:id", async (req, res) => {
  try {
    const partner = await prisma.partner.findUnique({
      where: { id: req.params.id },
      include: { projects: { include: { repos: true, termsInDali: true, teams: true } } },
    });
    if (!partner) return res.status(404).json({ error: "Partner not found" });
    res.json(partner);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /partners
// Body: { name, email, projectIds? }
router.post("/", async (req, res) => {
  try {
    const { name, email, projectIds } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "name and email are required" });
    }

    const partner = await prisma.partner.create({
      data: {
        name,
        email,
        ...(projectIds?.length && { projects: { connect: projectIds.map((id: string) => ({ id })) } }),
      },
      include: { projects: true },
    });

    res.status(201).json(partner);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /partners/:id
// Body: { name?, email?, projectIds? }
router.patch("/:id", async (req, res) => {
  try {
    const { name, email, projectIds } = req.body;

    const partner = await prisma.partner.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(email && { email }),
        ...(projectIds && { projects: { set: projectIds.map((id: string) => ({ id })) } }),
      },
      include: { projects: { include: { repos: true } } },
    });

    res.json(partner);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Partner not found" });
    res.status(500).json({ error: err.message });
  }
});

export default router;
