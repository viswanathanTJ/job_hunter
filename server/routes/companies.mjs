import express from 'express';
import { db, nowIso } from '../db.mjs';
import {
  listCompanies,
  getCompany,
  detectAts,
  deriveName,
  scanCompany,
  scanAllCompanies,
  companyJobs,
} from '../services/companyscan.mjs';

export const companiesRouter = express.Router();

companiesRouter.get('/companies', (req, res) => {
  res.json(listCompanies());
});

companiesRouter.post('/companies/scan-all', (req, res) => {
  res.status(202).json(scanAllCompanies({ analyze: req.body?.analyze !== false }));
});

// Single company in the same enriched shape as the list — the detail header.
companiesRouter.get('/companies/:id(\\d+)', (req, res) => {
  const company = listCompanies().find((c) => c.id === Number(req.params.id));
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json(company);
});

companiesRouter.post('/companies', (req, res) => {
  const careersUrl = String(req.body?.careers_url || '').trim();
  if (!careersUrl) return res.status(400).json({ error: 'careers_url is required — paste the company careers/jobs link' });
  let parsed;
  try {
    parsed = detectAts(careersUrl);
  } catch (e) {
    return res.status(400).json({ error: String(e.message) });
  }
  const name = String(req.body?.name || '').trim() || deriveName(careersUrl);
  const now = nowIso();
  try {
    const info = db
      .prepare(
        `INSERT INTO companies (name, careers_url, ats, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(name, careersUrl, parsed.ats, JSON.stringify(parsed.config), now, now);
    res.status(201).json(getCompany(Number(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This careers URL is already in the company list' });
    }
    res.status(500).json({ error: String(e.message) });
  }
});

companiesRouter.delete('/companies/:id', (req, res) => {
  const company = getCompany(Number(req.params.id));
  if (!company) return res.status(404).json({ error: 'Company not found' });
  db.prepare('DELETE FROM companies WHERE id = ?').run(company.id);
  res.json({ ok: true });
});

companiesRouter.post('/companies/:id/scan', (req, res) => {
  const company = getCompany(Number(req.params.id));
  if (!company) return res.status(404).json({ error: 'Company not found' });
  try {
    const result = scanCompany(company.id, { analyze: req.body?.analyze !== false });
    res.status(202).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// Jobs stored for one company, filterable — the detail-page list view.
companiesRouter.get('/companies/:id/jobs', (req, res) => {
  const company = getCompany(Number(req.params.id));
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json(companyJobs(company, req.query));
});
