import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../lib/generated/index.js";

const router = Router();

// GET /members?term=25W&role=FULLSTACK&active=true&page=1&limit=10&format=team
// format=team returns the TeamMember shape expected by the frontend Team page
router.get("/", async (req, res) => {
  try {
    const { term, role, active, format } = req.query;

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || (format === "team" ? 500 : 10);
    const offset = (page - 1) * limit;

    const members = await prisma.member.findMany({
      skip: offset,
      take: limit,
      where: {
        ...(term && { termsInDali: { some: { name: String(term) } } }),
        ...(role && { hiredRoles: { some: { role: String(role) as Role } } }),
        ...(active !== undefined && { isActive: active === "true" }),
      },
      include: {
        user: true,
        hiredRoles: true,
        termsInDali: { select: { name: true } },
        joinedTerm: { select: { name: true } },
        graduatedTerm: { select: { name: true } },
        memberTermRoles: { include: { term: { select: { name: true } }, project: { select: { id: true, name: true } } } },
        team: true,
        courses: true,
      },
    });

    if (format === "team") {
      const shaped = members.map(m => {
        const name =
          m.fullName ??
          (m.user ? `${m.user.firstName ?? ""} ${m.user.lastName ?? ""}`.trim() || null : null) ??
          m.daliEmail;

        const termsInDali = m.termsInDali.map(t => t.name);
        const hiredRoleStrings = m.hiredRoles.map(r => r.role.toLowerCase());

        return {
          id: m.id,
          name,
          role: m.roles[0] ?? m.currentRole ?? hiredRoleStrings[0] ?? "",
          roles: m.roles.length ? m.roles : hiredRoleStrings,
          hiredRoles: hiredRoleStrings,
          coreRoleNames: m.coreRoleNames,
          currentRole: m.currentRole ?? "",
          year: m.classYear ?? "",
          majorMinor: [m.major, m.minor].filter(Boolean).join(", "),
          termsInDali,
          profileImage: m.imageUrl ?? m.user?.picture ?? "",
          linkedinUrl: m.linkedinUrl ?? "",
          isAlum: m.isAlum,
          isActive: m.isActive,
          notionPageId: m.notionPageId,
        };
      });
      return res.json({ members: shaped });
    }

    res.json(members);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /members/:id
router.get("/:id", async (req, res) => {
  try {
    const member = await prisma.member.findUnique({
      where: { id: req.params.id },
      include: {
        user: true,
        hiredRoles: true,
        termsInDali: true,
        joinedTerm: true,
        graduatedTerm: true,
        memberTermRoles: { include: { term: true, project: true } },
        team: true,
        courses: true,
      },
    });

    if (!member) return res.status(404).json({ error: "Member not found" });
    res.json(member);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /members/:id
router.patch("/:id", async (req, res) => {
  try {
    const {
      daliEmail, imageUrl, classYear, major, minor, linkedinUrl,
      isActive, isAlum, graduatedTermName,
    } = req.body;

    let graduatedTermId: string | undefined;
    if (graduatedTermName) {
      const term = await prisma.term.findUnique({ where: { name: graduatedTermName } });
      if (!term) return res.status(400).json({ error: `Term "${graduatedTermName}" not found` });
      graduatedTermId = term.id;
    }

    const member = await prisma.member.update({
      where: { id: req.params.id },
      data: { daliEmail, imageUrl, classYear, major, minor, linkedinUrl, isActive, isAlum, graduatedTermId },
      include: {
        user: true,
        hiredRoles: true,
        termsInDali: true,
        joinedTerm: true,
        graduatedTerm: true,
        memberTermRoles: { include: { term: true, project: true } },
        team: true,
        courses: true,
      },
    });

    res.json(member);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Member not found" });
    if (err.code === "P2002") return res.status(409).json({ error: "A member with that email already exists" });
    res.status(500).json({ error: err.message });
  }
});

// POST /members/:id/roles — add a new hired role
router.post("/:id/roles", async (req, res) => {
  try {
    const { role, level } = req.body;
    if (!role || !level) return res.status(400).json({ error: "role and level are required" });
    const hiredRole = await prisma.hiredRole.create({
      data: { memberId: req.params.id, role: role as Role, level },
    });
    res.status(201).json(hiredRole);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /members/:id/roles/:roleId — update level of an existing hired role
router.patch("/:id/roles/:roleId", async (req, res) => {
  try {
    const { level } = req.body;
    if (!level) return res.status(400).json({ error: "level is required" });
    const hiredRole = await prisma.hiredRole.update({
      where: { id: req.params.roleId },
      data: { level },
    });
    res.json(hiredRole);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Role not found" });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /members/:id/roles/:roleId
router.delete("/:id/roles/:roleId", async (req, res) => {
  try {
    await prisma.hiredRole.delete({ where: { id: req.params.roleId } });
    res.status(204).end();
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Role not found" });
    res.status(500).json({ error: err.message });
  }
});

// POST /members
router.post("/", async (req, res) => {
  try {
    const {
      dartmouthEmail, daliEmail, joinedTermName,
      fullName, firstName, lastName, imageUrl, classYear, major, minor, linkedinUrl,
    } = req.body;

    if (!dartmouthEmail || !daliEmail || !joinedTermName) {
      return res.status(400).json({ error: "dartmouthEmail, daliEmail, and joinedTermName are required" });
    }

    const term = await prisma.term.findUnique({ where: { name: joinedTermName } });
    if (!term) return res.status(400).json({ error: `Term "${joinedTermName}" not found` });

    const member = await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { dartmouthEmail },
        update: { firstName, lastName },
        create: { dartmouthEmail, firstName, lastName, emailVerified: false },
      });

      return tx.member.create({
        data: {
          userId: user.id,
          fullName,
          daliEmail,
          joinedTermId: term.id,
          imageUrl,
          classYear,
          major,
          minor,
          linkedinUrl,
          termsInDali: { connect: { id: term.id } },
        },
        include: { user: true, joinedTerm: true },
      });
    });

    res.status(201).json(member);
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A member with that email already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
