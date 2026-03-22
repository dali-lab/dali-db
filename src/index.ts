import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { requireApiKey } from "./middleware/auth.js";
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import partnersRouter from "./routes/partners.js";
import membersRouter from "./routes/members.js";
import projectsRouter from "./routes/projects.js";
import termsRouter from "./routes/terms.js";
import coursesRouter from "./routes/courses.js";
import applicationsRouter from "./routes/applications.js";
import bidsRouter from "./routes/bids.js";
import accessGroupsRouter from "./routes/access-groups.js";

const app = express();
const PORT = process.env.PORT || 3001;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176,http://localhost:8080").split(",");

app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Auth routes are public (no API key required)
app.use("/auth", authRouter);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// All other routes require API key
app.use(requireApiKey);

app.use("/users", usersRouter);
app.use("/partners", partnersRouter);
app.use("/members", membersRouter);
app.use("/projects", projectsRouter);
app.use("/terms", termsRouter);
app.use("/courses", coursesRouter);
app.use("/applications", applicationsRouter);
app.use("/bids", bidsRouter);
app.use("/access-groups", accessGroupsRouter);

app.listen(PORT, () => {
  console.log(`dali-db API running on port ${PORT}`);
});
