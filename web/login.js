const SUPABASE_URL = 'https://fbtyjwpeymnguetrcwzt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Ke4bAiGgcM6bMxaOk-u2Zw_S9AMSo1C';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const MIN_PASSWORD_LENGTH = 8;
const form = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const submitButton = document.getElementById('submitButton');
const formError = document.getElementById('formError');
const loginView = document.getElementById('loginView');
const successView = document.getElementById('successView');
const { dashboard: crmUrl, resetPassword: resetPasswordUrl } = window.officeTrackerUrls;
let mode = 'signIn';

function goToCrm() {
  window.location.replace(crmUrl);
}

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
  submitButton.querySelector('span').textContent = loading
    ? (mode === 'signIn' ? 'Iniciando sesión…' : 'Creando cuenta…')
    : (mode === 'signIn' ? 'Iniciar sesión' : 'Crear cuenta');
}

function setMode(nextMode) {
  mode = nextMode;
  clearError();
  const signingIn = mode === 'signIn';
  document.getElementById('login-title').textContent = signingIn ? 'Bienvenido de vuelta.' : 'Crea tu cuenta.';
  document.getElementById('loginDescription').textContent = signingIn
    ? 'Ingresa con el correo y contraseña de tu cuenta.'
    : 'Regístrate con tu correo de trabajo y una contraseña de al menos 8 caracteres.';
  document.getElementById('toggleMode').textContent = signingIn ? 'Crear una cuenta' : 'Ya tengo una cuenta';
  document.getElementById('forgotPassword').hidden = !signingIn;
  passwordInput.autocomplete = signingIn ? 'current-password' : 'new-password';
  setLoading(false);
}

function showSuccess({ eyebrow, title, message }) {
  document.getElementById('successEyebrow').textContent = eyebrow;
  document.getElementById('successTitle').textContent = title;
  document.getElementById('successMessage').textContent = message;
  loginView.hidden = true;
  successView.hidden = false;
}

function restoreForm() {
  successView.hidden = true;
  loginView.hidden = false;
  clearError();
  emailInput.focus();
}

function validateCredentials() {
  if (!emailInput.checkValidity()) {
    showError('Ingresa un correo de trabajo válido.');
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

db.auth.onAuthStateChange((_event, session) => {
  if (session?.user) goToCrm();
});

db.auth.getSession().then(({ data, error }) => {
  if (error) console.warn('No se pudo verificar la sesión:', error.message);
  if (data.session?.user) goToCrm();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearError();
  if (!validateCredentials()) return;

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  setLoading(true);

  const { data, error } = mode === 'signIn'
    ? await db.auth.signInWithPassword({ email, password })
    : await db.auth.signUp({ email, password, options: { emailRedirectTo: crmUrl } });

  setLoading(false);
  if (error) {
    const message = mode === 'signIn'
      ? 'Correo o contraseña incorrectos. Inténtalo de nuevo o restablece tu contraseña.'
      : 'No fue posible crear la cuenta. Inténtalo de nuevo o consulta con la persona administradora.';
    console.warn('Error de autenticación:', error.message);
    showError(message);
    return;
  }

  if (data.session?.user) {
    goToCrm();
    return;
  }

  showSuccess({
    eyebrow: 'Cuenta creada',
    title: 'Revisa tu correo.',
    message: 'Te enviamos un enlace para confirmar tu correo y activar tu cuenta.',
  });
});

document.getElementById('toggleMode').addEventListener('click', () =>
  setMode(mode === 'signIn' ? 'signUp' : 'signIn'));

document.getElementById('forgotPassword').addEventListener('click', () => {
  window.location.assign(resetPasswordUrl);
});

document.getElementById('tryAnotherEmail').addEventListener('click', restoreForm);
