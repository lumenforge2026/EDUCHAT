require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`EduBot API (Sprint 02) rodando em http://localhost:${PORT}`);
});
