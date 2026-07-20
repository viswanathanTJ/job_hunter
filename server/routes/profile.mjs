import express from 'express';
import { getProfile, saveProfile, profileDefaults } from '../services/profile.mjs';

export const profileRouter = express.Router();

profileRouter.get('/profile', (req, res) => {
  res.json(getProfile());
});

profileRouter.put('/profile', (req, res) => {
  try {
    res.json(saveProfile(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: String(e.message) });
  }
});

profileRouter.post('/profile/reset', (req, res) => {
  res.json(saveProfile(profileDefaults()));
});
