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
        mentor: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true } },
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
    const { assignedProjectId, assignedRole, readyToMigrate, addedToAssignments, mentorOptOut, mentorId, externalMentor } = req.body;

    const bid = await prisma.bid.update({
      where: { id: req.params.id },
      data: {
        assignedProjectId,
        assignedRole,
        readyToMigrate,
        addedToAssignments,
        ...(mentorOptOut !== undefined && { mentorOptOut: mentorOptOut ?? null }),
        ...(mentorId !== undefined && { mentorId: mentorId ?? null }),
        ...(externalMentor !== undefined && { externalMentor: externalMentor ?? null }),
      },
      include: {
        member: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true, hiredRoles: { select: { role: true, level: true } } } },
        term: { select: { name: true } },
        assignedProject: { select: { id: true, name: true } },
        mentor: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true } },
      },
    });

    res.json(bid);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Bid not found" });
    res.status(500).json({ error: err.message });
  }
});

// POST /bids/publish — finalize assignments for a project+term
// Creates/upserts Team, sets members, creates MemberTermRole entries, sets project ACTIVE,
// marks bids addedToAssignments=true
router.post("/publish", async (req, res) => {
  try {
    const { projectId, term: termName } = req.body;
    if (!projectId || !termName) return res.status(400).json({ error: "projectId and term are required" });

    const VALID_ROLES = ["FULLSTACK", "DATA", "ENGINES", "AR_VR", "UI_UX", "VIDEO", "INSTRUCTOR", "PM"] as const;
    type RoleType = typeof VALID_ROLES[number];

    // Resolve term
    const term = await prisma.term.findUnique({ where: { name: String(termName) } });
    if (!term) return res.status(404).json({ error: `Term "${termName}" not found` });

    // Get all assigned bids for this project+term
    const assignedBids = await prisma.bid.findMany({
      where: { assignedProjectId: projectId, termId: term.id },
      include: { member: { select: { id: true, fullName: true } } },
    });

    if (assignedBids.length === 0) return res.status(400).json({ error: "No assigned bids for this project and term" });

    const memberIds = assignedBids.map(b => b.memberId);

    // Upsert Team (find existing or create)
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    if (!project) return res.status(404).json({ error: "Project not found" });

    let team = await prisma.team.findFirst({ where: { projectId, termId: term.id } });
    if (team) {
      // Update members: set to current assigned set
      team = await prisma.team.update({
        where: { id: team.id },
        data: { members: { set: memberIds.map(id => ({ id })) } },
      });
    } else {
      team = await prisma.team.create({
        data: {
          name: project.name,
          projectId,
          termId: term.id,
          members: { connect: memberIds.map(id => ({ id })) },
        },
      });
    }

    // Upsert MemberTermRole for each bid with a valid assignedRole
    for (const bid of assignedBids) {
      const role = bid.assignedRole?.toUpperCase() as RoleType | undefined;
      if (!role || !VALID_ROLES.includes(role)) continue;
      await prisma.memberTermRole.upsert({
        where: { memberId_termId_projectId_role: { memberId: bid.memberId, termId: term.id, projectId, role } },
        update: {},
        create: { memberId: bid.memberId, termId: term.id, projectId, role },
      });
    }

    // Set project status to ACTIVE
    await prisma.project.update({ where: { id: projectId }, data: { status: "ACTIVE" } });

    // Mark bids addedToAssignments=true
    await prisma.bid.updateMany({
      where: { assignedProjectId: projectId, termId: term.id },
      data: { addedToAssignments: true },
    });

    res.json({ teamId: team.id, memberCount: memberIds.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bids
router.post("/", async (req, res) => {
  try {
    const { memberId, termId, rolePref1, hoursPerWeek } = req.body;
    if (!memberId || !termId) return res.status(400).json({ error: "memberId and termId are required" });

    const bid = await prisma.bid.create({
      data: { memberId, termId, rolePref1, hoursPerWeek },
      include: {
        member: { select: { id: true, fullName: true, daliEmail: true, imageUrl: true, hiredRoles: { select: { role: true, level: true } } } },
        term: { select: { name: true } },
        projectPref1: { select: { id: true, name: true } },
        projectPref2: { select: { id: true, name: true } },
        projectPref3: { select: { id: true, name: true } },
        assignedProject: { select: { id: true, name: true } },
      },
    });

    res.status(201).json(bid);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /bids/:id
router.delete("/:id", async (req, res) => {
  try {
    await prisma.bid.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Bid not found" });
    res.status(500).json({ error: err.message });
  }
});

export default router;
