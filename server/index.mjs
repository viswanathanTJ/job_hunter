import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { WEB_DIST } from './paths.mjs';
import './db.mjs';
import { jobsRouter } from './routes/jobs.mjs';
import { ingestRouter } from './routes/ingest.mjs';
import { actionsRouter } from './routes/actions.mjs';
import { settingsRouter } from './routes/settings.mjs';
import { companiesRouter } from './routes/companies.mjs';
import { profileRouter } from './routes/profile.mjs';

const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', jobsRouter);
app.use('/api', ingestRouter);
app.use('/api', actionsRouter);
app.use('/api', settingsRouter);
app.use('/api', companiesRouter);
app.use('/api', profileRouter);

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res
      .status(200)
      .send('job-hunter API is running. Frontend not built yet — run: npm run build')
  );
}

const port = Number(process.env.PORT || 4680);
app.listen(port, () => {
  console.log(`job-hunter running at http://localhost:${port}`);
});
