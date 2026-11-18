// ATC phraseology, explained in French for the subtitles: the terms that appear in a call are shown under it.
// Longest phrases first, so "cleared for takeoff" wins over "cleared".

const TERMS: [string, string][] = [
  ["cleared for takeoff", "autorisé à décoller"],
  ["cleared to land", "autorisé à atterrir"],
  ["line up and wait", "s'aligner sur la piste et attendre"],
  ["position and hold", "s'aligner et attendre (ancienne formule US)"],
  ["hold short", "s'arrêter avant la piste ou le taxiway"],
  ["go around", "remise des gaz : interrompre l'atterrissage"],
  ["missed approach", "approche interrompue"],
  ["climb and maintain", "monter puis maintenir l'altitude"],
  ["descend and maintain", "descendre puis maintenir l'altitude"],
  ["frequency change approved", "peut quitter la fréquence"],
  ["contact departure", "passer sur la fréquence Départ"],
  ["contact approach", "passer sur la fréquence Approche"],
  ["contact ground", "passer sur la fréquence Sol"],
  ["contact tower", "passer sur la fréquence Tour"],
  ["contact center", "passer sur la fréquence du Centre en route"],
  ["monitor", "écouter une fréquence sans appeler"],
  ["visual approach", "approche à vue"],
  ["ils", "approche aux instruments (guidage radio)"],
  ["flight level", "niveau de vol, en centaines de pieds (FL350 ≈ 10 700 m)"],
  ["heading", "cap à suivre, en degrés"],
  ["vectors", "guidage radar par le contrôleur"],
  ["proceed direct", "route directe vers un point"],
  ["squawk", "code à afficher au transpondeur"],
  ["ident", "faire clignoter l'avion sur le radar"],
  ["traffic", "autre avion à surveiller"],
  ["in sight", "en vue"],
  ["altimeter", "calage altimétrique (pression)"],
  ["qnh", "calage altimétrique (pression)"],
  ["taxi", "rouler au sol"],
  ["pushback", "repoussage depuis la porte"],
  ["expect", "prévoir (pas encore autorisé)"],
  ["say again", "répétez"],
  ["standby", "patientez"],
  ["unable", "impossible"],
  ["affirmative", "oui"],
  ["negative", "non"],
  ["roger", "message reçu"],
  ["wilco", "reçu, j'exécute"],
  ["good day", "au revoir (fin du contact)"],
  ["heavy", "gros porteur (sillage turbulent)"],
  ["mayday", "détresse"],
  ["pan pan", "urgence"],
];

const MATCHERS = TERMS.sort((a, b) => b[0].length - a[0].length)
  .map(([en, fr]) => ({ en, fr, re: new RegExp(`\\b${en.replace(/ /g, "[\\s,-]+")}\\b`, "i") }));

/** The jargon in one call (at most `max`, in the order they appear), with its French meaning and where it is. */
export function glossFor(text: string, max = 3): { term: string; meaning: string; at: number; end: number }[] {
  const found: { term: string; meaning: string; at: number; end: number }[] = [];
  for (const m of MATCHERS) {
    const hit = m.re.exec(text);
    if (!hit) continue;
    const at = hit.index, end = at + hit[0].length;
    if (found.some((f) => at < f.end && end > f.at)) continue; // inside a longer phrase already found
    found.push({ term: m.en, meaning: m.fr, at, end });
  }
  return found.sort((a, b) => a.at - b.at).slice(0, max);
}
