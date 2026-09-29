// Mostrar/ocultar contraseña y aviso de Bloq Mayús (misma lógica que login.js).
(() => {
function mejorarPassword(input) {
  const wrap = document.createElement('div');
  wrap.className = 'pw-wrap';
  input.replaceWith(wrap);
  wrap.appendChild(input);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'pw-toggle'; btn.textContent = 'Mostrar';
  btn.addEventListener('click', () => {
    const ver = input.type === 'password';
    input.type = ver ? 'text' : 'password';
    btn.textContent = ver ? 'Ocultar' : 'Mostrar';
    input.focus();
  });
  wrap.appendChild(btn);
  const caps = document.createElement('p');
  caps.className = 'pw-caps'; caps.hidden = true; caps.textContent = 'Bloq Mayús activado';
  wrap.after(caps);
  const ver = e => { caps.hidden = !e.getModifierState?.('CapsLock'); };
  input.addEventListener('keydown', ver);
  input.addEventListener('keyup', ver);
  input.addEventListener('blur', () => { caps.hidden = true; });
}
document.querySelectorAll('input[type="password"]').forEach(mejorarPassword);
})();
