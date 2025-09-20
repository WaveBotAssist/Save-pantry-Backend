// Nettoyage du planning :
// 1. Garde uniquement les X derniers jours (par défaut 60)
// 2. Supprime les semaines vides (aucun produit ni recette)
function cleanPlanning(planning, maxAgeDays = 60) {
  const now = new Date();

  // Filtrer les semaines valides
  const filteredWeeks = planning.weeks.filter(week => {
    const weekDate = new Date(week.weekStart);
    const ageDays = (now - weekDate) / (1000 * 60 * 60 * 24);

    // 1️⃣ Supprimer si trop vieux
    if (ageDays > maxAgeDays) return false;

    // 2️⃣ Supprimer si days est absent ou vide
    if (!week.days || week.days.size === 0) {
      return false;
    }

    // 3️⃣ Supprimer si aucun contenu dans les jours
    const hasContent = Array.from(week.days.values()).some(day =>
      (day.recipe !== null) ||
      (Array.isArray(day.stockItems) && day.stockItems.length > 0)
    );

    return hasContent;
  });

  // Remplacer le contenu du tableau sans changer sa référence
  planning.weeks.splice(0, planning.weeks.length, ...filteredWeeks);

  return planning;
}

module.exports = { cleanPlanning };