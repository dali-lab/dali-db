import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

const memberSelect = {
  id: true,
  daliEmail: true,
  fullName: true,
  imageUrl: true,
  hiredRoles: { select: { role: true, level: true } },
};

// GET /access-groups
router.get("/", async (_req, res) => {
  try {
    const groups = await prisma.accessGroup.findMany({
      include: {
        members: {
          include: { member: { select: memberSelect } },
          orderBy: { addedAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json(groups);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /access-groups/:id
router.get("/:id", async (req, res) => {
  try {
    const group = await prisma.accessGroup.findUnique({
      where: { id: req.params.id },
      include: {
        members: {
          include: { member: { select: memberSelect } },
          orderBy: { addedAt: "asc" },
        },
      },
    });
    if (!group) return res.status(404).json({ error: "Group not found" });
    res.json(group);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /access-groups
// Body: { name, description?, permissions? }
router.post("/", async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });

    const group = await prisma.accessGroup.create({
      data: { name: name.trim(), description: description?.trim() ?? null, permissions: permissions ?? [] },
      include: { members: true },
    });
    res.status(201).json(group);
  } catch (err: any) {
    if (err.code === "P2002") return res.status(409).json({ error: "A group with that name already exists" });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /access-groups/:id
// Body: { name?, description?, permissions? }
router.patch("/:id", async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    const group = await prisma.accessGroup.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() ?? null }),
        ...(permissions !== undefined && { permissions }),
      },
      include: {
        members: {
          include: { member: { select: memberSelect } },
        },
      },
    });
    res.json(group);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Group not found" });
    if (err.code === "P2002") return res.status(409).json({ error: "A group with that name already exists" });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /access-groups/:id
router.delete("/:id", async (req, res) => {
  try {
    await prisma.accessGroup.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Group not found" });
    res.status(500).json({ error: err.message });
  }
});

// POST /access-groups/:id/members
// Body: { memberId }
router.post("/:id/members", async (req, res) => {
  try {
    const { memberId } = req.body;
    if (!memberId) return res.status(400).json({ error: "memberId is required" });

    await prisma.accessGroupMember.create({
      data: { groupId: req.params.id, memberId },
    });

    const group = await prisma.accessGroup.findUnique({
      where: { id: req.params.id },
      include: {
        members: {
          include: { member: { select: memberSelect } },
          orderBy: { addedAt: "asc" },
        },
      },
    });
    res.status(201).json(group);
  } catch (err: any) {
    if (err.code === "P2002") return res.status(409).json({ error: "Member is already in this group" });
    if (err.code === "P2025") return res.status(404).json({ error: "Group or member not found" });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /access-groups/:id/members/:memberId
router.delete("/:id/members/:memberId", async (req, res) => {
  try {
    await prisma.accessGroupMember.delete({
      where: { groupId_memberId: { groupId: req.params.id, memberId: req.params.memberId } },
    });
    res.status(204).send();
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Member not found in group" });
    res.status(500).json({ error: err.message });
  }
});

export default router;
