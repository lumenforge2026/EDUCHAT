// RF-03 — o back-end avalia a data de prazo (deadline < now()) para
// classificar a oportunidade como Ativa ou Encerrada. Rascunho tem
// precedência, pois ainda não foi publicada.
function classifyStatus(opportunity) {
  if (opportunity.is_draft) return 'Rascunho';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(opportunity.deadline);

  return deadline < today ? 'Encerrada' : 'Ativa';
}

module.exports = { classifyStatus };
