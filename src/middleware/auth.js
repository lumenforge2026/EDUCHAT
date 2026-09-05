const { verifyToken } = require('../utils/jwt');

// RF-20/RF-21 — bloqueia acesso sem token válido e distingue perfis.
// Uma sessão expirada (JWT_EXPIRES_IN) é tratada como "sessão inativa encerrada".
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Acesso não autorizado. Faça login novamente.' });
  }

  try {
    req.user = verifyToken(token);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Perfil sem permissão para este recurso.' });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
