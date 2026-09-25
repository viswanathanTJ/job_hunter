import express from 'express';
import { getProfile, saveProfile, profileDefaults } from '../services/profile.mjs';

export const profileRouter = express.Router();

profileRouter.get('/profile', (req, res) => {
  res.json(getProfile());
});

profileRouter.put('/profile', (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (body.maxYoeAsk !== undefined) {
      const n = Number(body.maxYoeAsk);
      if (!Number.isFinite(n) || n < 0 || n > 50) return res.status(400).json({ error: 'Experience cap must be between 0 and 50' });
      body.maxYoeAsk = n;
    }
    if (body.yearsExperience !== undefined) {
      const n = Number(body.yearsExperience);
      if (!Number.isFinite(n) || n < 0 || n > 50) return res.status(400).json({ error: 'Years of experience must be between 0 and 50' });
      body.yearsExperience = n;
    }
    res.json(saveProfile(body));
  } catch (e) {
    res.status(400).json({ error: String(e.message) });
  }
});

profileRouter.post('/profile/reset', (req, res) => {
  res.json(saveProfile(profileDefaults()));
});
