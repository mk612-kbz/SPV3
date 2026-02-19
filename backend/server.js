const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 3000;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const DATA_FILE = path.join(__dirname, "clients.json");
const CIF_DATA_FILE = path.join(__dirname, "cif-data.json");
const SERVICE_LIST_FILE = path.join(__dirname, "service-list.json");

const generateClientId = () => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cli_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
};

const readClients = () => {
  const clients = fs.existsSync(DATA_FILE)
    ? JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"))
    : [];
  let updated = false;
  clients.forEach((entry) => {
    if (!entry?.client?.id) {
      const safeEntry = entry || { client: {} };
      safeEntry.client = safeEntry.client || {};
      safeEntry.client.id = generateClientId();
      updated = true;
    }
  });
  if (updated) {
    writeClients(clients);
  }
  return clients;
};

const writeClients = (clients) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(clients, null, 2));
};

const normalizeClient = (client, existingEntry = {}) => {
  const existing = existingEntry.client || {};
  return {
    client: {
      ...existing,
      ...client,
      id: client.id || existing.id || generateClientId(),
      services: Array.isArray(client.services)
        ? client.services
        : Array.isArray(existing.services)
          ? existing.services
          : [],
      bankAccounts: Array.isArray(client.bankAccounts)
        ? client.bankAccounts
        : Array.isArray(existing.bankAccounts)
          ? existing.bankAccounts
          : [],
      createdAt:
        client.createdAt || existing.createdAt || new Date().toISOString(),
      status: client.status || existing.status || "active",
    },
  };
};

const findClientIndexById = (clients, id) =>
  clients.findIndex((entry) => entry?.client?.id === id);

const findClientIndexByCif = (clients, cif) =>
  clients.findIndex((entry) => entry?.client?.cif === cif);

const findCifConflict = (clients, cif, clientId) => {
  if (!cif) return -1;
  return clients.findIndex((entry) => {
    const existing = entry?.client || {};
    if (!existing.cif || existing.cif !== cif) return false;
    if (clientId && existing.id === clientId) return false;
    return true;
  });
};

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

const readRequestBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error("Payload too large"));

        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const serveStatic = (req, res) => {
  const urlPath = req.url.split("?")[0];
  const routeMap = {
    "/": "index.html",
    "/client-detail": "client-detail.html",
    "/client-detail.html": "client-detail.html",
    "/clients-list": "index.html",
    "/clients-list.html": "index.html",
    "/create-client": "create-client.html",
    "/create-client.html": "create-client.html",
    "/update-client": "update-client.html",
    "/update-client.html": "update-client.html",
    "/update-draft": "update-draft.html",
    "/update-draft.html": "update-draft.html",
  };
  const filePath = routeMap[urlPath] || urlPath.replace(/^\//, "");
  const resolvedPath = path.resolve(FRONTEND_DIR, filePath);

  if (!resolvedPath.startsWith(FRONTEND_DIR)) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  fs.readFile(resolvedPath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const typeMap = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json",
    };

    res.writeHead(200, { "Content-Type": typeMap[ext] || "text/plain" });
    res.end(content);
  });
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, OPTIONS, DELETE",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/api/clients") {
    try {
      const raw = await readRequestBody(req);
      const payload = JSON.parse(raw || "{}");
      const client = payload.client || {};
      const existing = readClients();
      const conflictIndex = findCifConflict(existing, client.cif, client.id);
      if (conflictIndex >= 0) {
        return sendJson(res, 409, {
          ok: false,
          message: "Client with the same CIF already exists",
        });
      }
      const idIndex = client.id ? findClientIndexById(existing, client.id) : -1;
      const draftIndex = existing.findIndex(
        (entry) =>
          entry?.client?.cif &&
          entry.client.cif === client.cif &&
          entry.client.status === "draft",
      );
      const targetIndex = idIndex >= 0 ? idIndex : draftIndex;
      const normalized = normalizeClient(client, existing[targetIndex]);
      normalized.client.status = "active";
      normalized.client.draftUpdatedAt = null;

      if (targetIndex >= 0) {
        existing[targetIndex] = normalized;
      } else {
        existing.push(normalized);
      }
      writeClients(existing);

      return sendJson(res, 201, {
        ok: true,
        count: existing.length,
        id: normalized.client.id,
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/api/clients/draft") {
    try {
      const raw = await readRequestBody(req);
      const payload = JSON.parse(raw || "{}");
      const client = payload.client || {};
      if (!client.cif) {
        return sendJson(res, 400, { ok: false, message: "CIF is required" });
      }

      const existing = readClients();
      const conflictIndex = findCifConflict(existing, client.cif, client.id);
      if (conflictIndex >= 0) {
        return sendJson(res, 409, {
          ok: false,
          message: "Client with the same CIF already exists",
        });
      }
      const idIndex = client.id ? findClientIndexById(existing, client.id) : -1;
      const cifIndex = client.cif
        ? findClientIndexByCif(existing, client.cif)
        : -1;
      const targetIndex = idIndex >= 0 ? idIndex : cifIndex;

      if (
        targetIndex >= 0 &&
        existing[targetIndex]?.client?.status !== "draft"
      ) {
        return sendJson(res, 409, {
          ok: false,
          message: "Client already exists",
        });
      }
      const normalized = normalizeClient(client, existing[targetIndex]);
      normalized.client.status = "draft";
      normalized.client.draftUpdatedAt = new Date().toISOString();

      if (targetIndex >= 0) {
        existing[targetIndex] = normalized;
      } else {
        existing.push(normalized);
      }
      writeClients(existing);

      return sendJson(res, 200, {
        ok: true,
        count: existing.length,
        id: normalized.client.id,
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "GET" && req.url === "/api/clients") {
    const existing = readClients();
    return sendJson(res, 200, existing);
  }

  if (req.method === "GET" && req.url.startsWith("/api/cif/")) {
    const cif = decodeURIComponent(req.url.replace("/api/cif/", "")).trim();
    const data = fs.existsSync(CIF_DATA_FILE)
      ? JSON.parse(fs.readFileSync(CIF_DATA_FILE, "utf-8"))
      : {};

    if (!cif || !data[cif]) {
      return sendJson(res, 404, { ok: false, message: "CIF not found" });
    }

    return sendJson(res, 200, { ok: true, data: data[cif] });
  }

  if (req.method === "GET" && req.url === "/api/services") {
    const services = fs.existsSync(SERVICE_LIST_FILE)
      ? JSON.parse(fs.readFileSync(SERVICE_LIST_FILE, "utf-8"))
      : [];

    return sendJson(res, 200, { ok: true, data: services });
  }

  if (req.method === "DELETE" && req.url.startsWith("/api/clients/")) {
    try {
      const clientId = req.url.replace("/api/clients/", "").trim();
      if (!clientId) {
        return sendJson(res, 400, { ok: false, message: "Invalid client id" });
      }

      const existing = readClients();
      const targetIndex = findClientIndexById(existing, clientId);
      if (targetIndex < 0) {
        return sendJson(res, 404, { ok: false, message: "Client not found" });
      }

      existing.splice(targetIndex, 1);
      writeClients(existing);

      return sendJson(res, 200, { ok: true, count: existing.length });
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "PUT" && req.url.startsWith("/api/clients/")) {
    try {
      const clientId = req.url.replace("/api/clients/", "").trim();
      if (!clientId) {
        return sendJson(res, 400, { ok: false, message: "Invalid client id" });
      }

      const existing = readClients();

      const targetIndex = findClientIndexById(existing, clientId);
      if (targetIndex < 0) {
        return sendJson(res, 404, { ok: false, message: "Client not found" });
      }

      const raw = await readRequestBody(req);
      const payload = JSON.parse(raw || "{}");
      const client = payload.client || {};
      const normalized = normalizeClient(
        { ...client, id: clientId },
        existing[targetIndex],
      );

      existing[targetIndex] = normalized;
      writeClients(existing);

      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: error.message });
    }
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
