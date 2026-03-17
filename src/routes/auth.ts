import { Router, Request, Response, CookieOptions } from "express";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import { prisma } from "../../lib/prisma.js";

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = "15m";
const REFRESH_EXPIRES_DAYS = 7;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const REFRESH_COOKIE: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  path: "/auth",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateRefreshToken(): string {
  // 32 random bytes as hex = 64-char string
  return createHash("sha256")
    .update(Math.random().toString() + Date.now().toString())
    .digest("hex");
}

function signAccessToken(payload: { id: string; type: "USER" | "PARTNER" }) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

async function issueTokens(
  res: Response,
  accountId: string,
  accountType: "USER" | "PARTNER"
) {
  const accessToken = signAccessToken({ id: accountId, type: accountType });

  const refreshRaw = generateRefreshToken();
  const expiresAt = new Date(
    Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000
  );

  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(refreshRaw),
      accountId,
      accountType,
      expiresAt,
    },
  });

  res.cookie("refresh_token", refreshRaw, REFRESH_COOKIE);
  return accessToken;
}

async function verifyGoogleToken(idToken: string) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("Invalid Google token");
  return payload;
}

// ── POST /auth/google/member ───────────────────────────────────────────────
// DALI members — must have @dali.dartmouth.edu email

router.post("/google/member", async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: "idToken required" });

    const payload = await verifyGoogleToken(idToken);
    const { sub: googleId, email, given_name, family_name, picture } = payload;

    if (!email) return res.status(400).json({ error: "No email in token" });

    if (!email.endsWith("@dali.dartmouth.edu")) {
      return res.status(403).json({ error: "Must use a @dali.dartmouth.edu Google account" });
    }

    const user = await prisma.user.upsert({
      where: { dartmouthEmail: email },
      update: {
        googleId,
        picture: picture ?? undefined,
        emailVerified: true,
        ...(given_name && { firstName: given_name }),
        ...(family_name && { lastName: family_name }),
      },
      create: {
        dartmouthEmail: email,
        googleId,
        picture,
        emailVerified: true,
        firstName: given_name,
        lastName: family_name,
      },
      include: { member: true },
    });

    const accessToken = await issueTokens(res, user.id, "USER");

    return res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.dartmouthEmail,
        firstName: user.firstName,
        lastName: user.lastName,
        picture: user.picture,
        isMember: !!user.member,
      },
    });
  } catch (err: any) {
    console.error("Google member auth error:", err.message);
    return res.status(401).json({ error: "Authentication failed" });
  }
});

// ── POST /auth/google/user ─────────────────────────────────────────────────
// Dartmouth students — must have @dartmouth.edu email (NOT @dali.dartmouth.edu)

router.post("/google/user", async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: "idToken required" });

    const payload = await verifyGoogleToken(idToken);
    const { sub: googleId, email, given_name, family_name, picture, hd } = payload;

    if (!email) return res.status(400).json({ error: "No email in token" });

    // Reject DALI member emails — they should use the /member endpoint
    if (email.endsWith("@dali.dartmouth.edu")) {
      return res.status(403).json({ error: "DALI members must sign in as a DALI Member, not as a Dartmouth Student" });
    }

    // Enforce @dartmouth.edu domain
    if (hd !== "dartmouth.edu" && !email.endsWith("@dartmouth.edu")) {
      return res.status(403).json({ error: "Must use a @dartmouth.edu Google account" });
    }

    const user = await prisma.user.upsert({
      where: { dartmouthEmail: email },
      update: {
        googleId,
        picture: picture ?? undefined,
        emailVerified: true,
        ...(given_name && { firstName: given_name }),
        ...(family_name && { lastName: family_name }),
      },
      create: {
        dartmouthEmail: email,
        googleId,
        picture,
        emailVerified: true,
        firstName: given_name,
        lastName: family_name,
      },
      include: { member: true },
    });

    const accessToken = await issueTokens(res, user.id, "USER");

    return res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.dartmouthEmail,
        firstName: user.firstName,
        lastName: user.lastName,
        picture: user.picture,
        isMember: !!user.member,
      },
    });
  } catch (err: any) {
    console.error("Google user auth error:", err.message);
    return res.status(401).json({ error: "Authentication failed" });
  }
});

// ── POST /auth/google/partner ──────────────────────────────────────────────
// Partners — any Google account, matched by email to existing Partner record
// If no Partner record exists, creates one (name from Google profile)

router.post("/google/partner", async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: "idToken required" });

    const payload = await verifyGoogleToken(idToken);
    const { sub: googleId, email, name, given_name, family_name, picture } = payload;

    if (!email) return res.status(400).json({ error: "No email in token" });

    // Reject Dartmouth emails — they should use the student or member endpoints
    if (email.endsWith("@dartmouth.edu") || email.endsWith("@dali.dartmouth.edu")) {
      return res.status(403).json({ error: "Dartmouth accounts must sign in as a Dartmouth Student or DALI Member" });
    }

    const displayName = name ?? `${given_name ?? ""} ${family_name ?? ""}`.trim() ?? email;

    const partner = await prisma.partner.upsert({
      where: { email },
      update: {
        googleId,
        picture: picture ?? undefined,
        emailVerified: true,
      },
      create: {
        email,
        name: displayName,
        googleId,
        picture,
        emailVerified: true,
      },
      include: { projects: true },
    });

    const accessToken = await issueTokens(res, partner.id, "PARTNER");

    return res.json({
      accessToken,
      partner: {
        id: partner.id,
        email: partner.email,
        name: partner.name,
        picture: partner.picture,
        projectCount: partner.projects.length,
      },
    });
  } catch (err: any) {
    console.error("Google partner auth error:", err.message);
    return res.status(401).json({ error: "Authentication failed" });
  }
});

// ── POST /auth/refresh ─────────────────────────────────────────────────────
// Exchange httpOnly refresh cookie for a new access token

router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const raw = req.cookies?.refresh_token;
    if (!raw) return res.status(401).json({ error: "No refresh token" });

    const tokenHash = hashToken(raw);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.expiresAt < new Date()) {
      res.clearCookie("refresh_token", { path: "/auth" });
      return res.status(401).json({ error: "Refresh token invalid or expired" });
    }

    // Rotate: delete old, issue new
    await prisma.refreshToken.delete({ where: { tokenHash } });
    const accessToken = await issueTokens(res, stored.accountId, stored.accountType);

    return res.json({ accessToken });
  } catch (err: any) {
    console.error("Refresh error:", err.message);
    return res.status(401).json({ error: "Authentication failed" });
  }
});

// ── POST /auth/link-member ─────────────────────────────────────────────────
// Links the authenticated User to their Member record by matching
// user.dartmouthEmail === member.daliEmail. Bearer JWT required.

router.post("/link-member", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    let payload: { id: string; type: string };
    try {
      payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { id: string; type: string };
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    if (payload.type !== "USER") {
      return res.status(403).json({ error: "Only USER accounts can link a DALI profile" });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      include: { member: true },
    });

    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.member) return res.status(409).json({ error: "Account is already linked to a DALI profile" });

    const member = await prisma.member.findUnique({
      where: { daliEmail: user.dartmouthEmail },
    });

    if (!member) return res.status(404).json({ error: "No DALI profile found for your email address" });
    if (member.userId !== null) return res.status(409).json({ error: "This DALI profile is already linked to another account" });

    await prisma.member.update({
      where: { id: member.id },
      data: { userId: user.id },
    });

    return res.json({ ok: true, memberId: member.id });
  } catch (err: any) {
    console.error("Link member error:", err.message);
    return res.status(500).json({ error: "Failed to link account" });
  }
});

// ── POST /auth/logout ──────────────────────────────────────────────────────

router.post("/logout", async (req: Request, res: Response) => {
  const raw = req.cookies?.refresh_token;
  if (raw) {
    await prisma.refreshToken
      .delete({ where: { tokenHash: hashToken(raw) } })
      .catch(() => {}); // ignore if already gone
  }
  res.clearCookie("refresh_token", { path: "/auth" });
  return res.json({ ok: true });
});

export default router;
