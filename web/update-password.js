const SUPABASE_URL = 'https://fbtyjwpeymnguetrcwzt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Ke4bAiGgcM6bMxaOk-u2Zw_S9AMSo1C';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const form = document.getElementById('updateForm');
const passwordInput = document.getElementById('password');
const confirmationInput = document.getElementById('passwordConfirmation');
const formError = document.getElementById('formError');
const submitButton = document.getElementById('submitButton');
let recoverySessionReady = false;

db.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY' && session?.user) recoverySessionReady = true;
});

db.auth.getSession().then(({ data, error }) => {
  if (error) console.warn('No se pudo validar el enlace de recuperación:', error.message);
  if (data.session?.user) recoverySessionReady = true;
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  formError.hidden = true;
  if (passwordInput.value.length < 8) {
    formError.textContent = 'La contraseña debe tener al menos 8 caracteres.';
    formError.hidden = false;
    passwordInput.focus();
    return;
  }
  if (passwordInput.value !== confirmationInput.value) {
    formError.textContent = 'Las contraseñas no coinciden.';
    formError.hidden = false;
    confirmationInput.focus();
    return;
  }
  if (!recoverySessionReady) {
    formError.textContent = 'El enlace es inválido o venció. Solicita uno nuevo.';
    formError.hidden = false;
    return;
  }

  submitButton.disabled = true;
  submitButton.querySelector('span').textContent = 'Guardando…';
  const { error } = await db.auth.updateUser({ password: passwordInput.value });
  submitButton.disabled = false;
  submitButton.querySelector('span').textContent = 'Guardar contraseña';

  if (error) {
    console.warn('No se pudo actualizar la contraseña:', error.message);
    formError.textContent = 'No fue posible actualizar la contraseña. Solicita un enlace nuevo.';
    formError.hidden = false;
    return;
  }

  document.getElementById('updateView').hidden = true;
  document.getElementById('successView').hidden = false;
});
