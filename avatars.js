/* Add supplied artwork here as { id, label, src: 'assets/avatars/name.webp' }.
   Only catalog IDs travel over the peer connection; remote markup is never rendered. */
const AVATAR_CATALOG = Object.freeze([
  { id: 'chrome', label: 'Cromo', finish: 'chrome' },
  { id: 'carbon', label: 'Carbono', finish: 'carbon' },
  { id: 'frost', label: 'Polar', finish: 'frost' }
]);
const AVATARS = AVATAR_CATALOG.map(avatar => avatar.id);

function normalizeAvatar(value) {
  return AVATARS.includes(value) ? value : 'chrome';
}

function profileInitials(name) {
  const words = String(name || 'Visitante').trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || 'V').slice(0, 2)).toLocaleUpperCase('pt-BR');
}

function renderAvatar(element, avatar, name) {
  if (!element) return;
  const choice = AVATAR_CATALOG.find(item => item.id === normalizeAvatar(avatar));
  element.replaceChildren();
  element.dataset.finish = choice.finish || 'artwork';
  element.classList.add('identity');
  element.setAttribute('aria-label', 'Perfil de ' + String(name || 'Visitante'));
  if (choice.src) {
    const img = document.createElement('img');
    img.src = choice.src;
    img.alt = '';
    img.addEventListener('error', () => { element.textContent = profileInitials(name); }, { once: true });
    element.appendChild(img);
  } else {
    const monogram = document.createElement('span');
    monogram.textContent = profileInitials(name);
    element.appendChild(monogram);
  }
}
