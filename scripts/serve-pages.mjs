#!/usr/bin/env node
import express from "express";
import { DIST_DIR } from "./build-pages.mjs";
const port = Number(process.env.PORT || 3101);
const base = process.env.CELIA_PAGES_BASE_PATH || "/";
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !/^\/[A-Za-z0-9/_-]*$/.test(base)
)
  throw new Error("Invalid static preview address");
const app = express();
app.disable("x-powered-by");
app.use(base, express.static(DIST_DIR, { dotfiles: "deny" }));
app.listen(port, "0.0.0.0", () =>
  console.log(`Static preview on 0.0.0.0:${port}${base}`),
);
