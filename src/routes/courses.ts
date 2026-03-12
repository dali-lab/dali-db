import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

// GET /courses?term=25W&type=WORKSHOP
router.get("/", async (req, res) => {
  try {
    const { term, type } = req.query;

    const courses = await prisma.course.findMany({
      where: {
        ...(term && { term: { name: String(term) } }),
        ...(type && { courseType: String(type) as any }),
      },
      include: {
        term: true,
        instructor: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
    });

    res.json(courses);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /courses/:id
router.get("/:id", async (req, res) => {
  try {
    const course = await prisma.course.findUnique({
      where: { id: req.params.id },
      include: {
        term: true,
        instructor: { include: { user: { select: { firstName: true, lastName: true } } } },
        enrollments: { include: { user: { select: { firstName: true, lastName: true, dartmouthEmail: true } } } },
      },
    });

    if (!course) return res.status(404).json({ error: "Course not found" });
    res.json(course);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
