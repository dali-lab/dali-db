import express from "express";
import { requireApiKey } from "./middleware/auth.js";
import usersRouter from "./routes/users.js";
import membersRouter from "./routes/members.js";
import projectsRouter from "./routes/projects.js";
import termsRouter from "./routes/terms.js";
import coursesRouter from "./routes/courses.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(requireApiKey);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/users", usersRouter);
app.use("/members", membersRouter);
app.use("/projects", projectsRouter);
app.use("/terms", termsRouter);
app.use("/courses", coursesRouter);

app.listen(PORT, () => {
  console.log(`dali-db API running on port ${PORT}`);
});
