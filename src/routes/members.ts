import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../lib/generated/index.js";

const router = Router();

// GET /members?term=25W&role=FULLSTACK&active=true&page=1&limit=10
router.get("/", async (req, res) => {
  try {
    const { term, role, active } = req.query;

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
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
        termsInDali: true,
        joinedTerm: true,
        graduatedTerm: true,
        memberTermRoles: { include: { term: true, project: true } },
        team: true,
        courses: true,
      },
    });

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
// Body: { daliEmail?, imageUrl?, classYear?, major?, minor?, linkedinUrl?, isActive?, isAlum?, graduatedTermName? }
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

// POST /members
// Creates a User (if not existing) and a Member in one transaction.
// Body: { dartmouthEmail, daliEmail, joinedTermName, firstName?, lastName?, imageUrl?, classYear?, major?, minor?, linkedinUrl? }
router.post("/", async (req, res) => {
  try {
    const {
      dartmouthEmail, daliEmail, joinedTermName,
      firstName, lastName, imageUrl, classYear, major, minor, linkedinUrl,
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
          daliEmail,
          joinedTermId: term.id,
          imageUrl,
          classYear,
          major,
          minor,
          linkedinUrl,
          termsInDali: { connect: { id: term.id } },
        },
        include: {
          user: true,
          joinedTerm: true,
        },
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
