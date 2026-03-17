import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

// GET /users
router.get("/", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: { member: true, enrollments: true },
    });
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /users/:id
router.get("/:id", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        member: true,
        enrollments: { include: { course: { include: { term: true } } }, orderBy: { enrolledAt: "desc" } },
        applications: { include: { term: true }, orderBy: { submittedAt: "desc" } },
      },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /users/:id
// Body: { firstName?, lastName?, googleId?, picture?, emailVerified? }
router.patch("/:id", async (req, res) => {
  try {
    const { firstName, lastName, googleId, picture, emailVerified } = req.body;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { firstName, lastName, googleId, picture, emailVerified },
      include: { member: true },
    });

    res.json(user);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "User not found" });
    res.status(500).json({ error: err.message });
  }
});

// POST /users
// Body: { dartmouthEmail, firstName?, lastName?, googleId?, picture? }
router.post("/", async (req, res) => {
  try {
    const { dartmouthEmail, firstName, lastName, googleId, picture } = req.body;

    if (!dartmouthEmail) {
      return res.status(400).json({ error: "dartmouthEmail is required" });
    }

    const user = await prisma.user.create({
      data: { dartmouthEmail, firstName, lastName, googleId, picture, emailVerified: false },
    });

    res.status(201).json(user);
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A user with that email already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
