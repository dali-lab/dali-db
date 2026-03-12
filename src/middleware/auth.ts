import { Request, Response, NextFunction } from "express";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (process.env.DISABLE_AUTH === "true" || !process.env.API_KEY) {
    return next();
  }
  const key = req.headers.authorization?.replace("Bearer ", "");
  if (key === process.env.API_KEY) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
}
