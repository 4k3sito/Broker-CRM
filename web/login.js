// Autenticación contra la API propia. La sesión vive en una cookie httponly:
// este archivo nunca ve el token.
const MIN_PASSWORD_LENGTH = 8;
const form = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const submitButton = document.getElementById('submitButton');
const formError = document.getElementById('formError');

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearError() {
  formError.textContent = '';
  formError.hidden = true;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector('span').textContent = loading ? 'Entrando…' : 'Entrar';
}

// Mostrar/ocultar contraseña y aviso de Bloq Mayús. Se cuelgan de cualquier
// input[type=password] de la página, así sirven también en recuperar/actualizar.
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

// El correo se recuerda en este equipo (nunca la contraseña).
try {
  const g = localStorage.getItem('ol-email');
  if (g && !emailInput.value) { emailInput.value = g; passwordInput.focus(); }
} catch { /* modo privado */ }

function validateCredentials() {
  if (!emailInput.checkValidity()) {
    showError('Ingresa un correo válido.');
    emailInput.focus();
    return false;
  }
  if (passwordInput.value.length < MIN_PASSWORD_LENGTH) {
    showError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    passwordInput.focus();
    return false;
  }
  return true;
}

// Si ya hay sesión, no tiene caso mostrar el formulario.
API.me().then(() => location.replace('index.html')).catch(() => {});

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearError();
  if (!validateCredentials()) return;

  setLoading(true);
  try {
    await API.login(emailInput.value.trim(), passwordInput.value);
    try { localStorage.setItem('ol-email', emailInput.value.trim()); } catch { /* sin persistencia */ }
    location.replace('index.html');
  } catch (err) {
    // 429 del limitador trae su propio mensaje; el resto se generaliza para no
    // revelar si el correo existe.
    showError(/Demasiados/.test(err.message)
      ? err.message
      : 'Correo o contraseña incorrectos.');
    setLoading(false);
  }
});
