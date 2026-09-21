const path = require('path');
const express = require('express');
const cors = require('cors');
const routes = require('./routes');

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/api', routes);

  // 生产环境：托管 React 构建产物
  const dist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  return app;
}

const app = createApp();

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`旅行社计调平台已启动: http://localhost:${PORT}`));
}

module.exports = { app, createApp };
