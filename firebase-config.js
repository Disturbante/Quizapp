// Inserisci qui la configurazione della tua app Web Firebase.
// La configurazione Firebase per il client è pubblica; non inserire mai service-account key o segreti server-side.
const firebaseConfig = {
  apiKey: "AIzaSyC5nwoL7p2uAOaWiN9cnFPf3IMKX6f6Phc",
  authDomain: "quizapp-39058.firebaseapp.com",
  projectId: "quizapp-39058",
  storageBucket: "quizapp-39058.firebasestorage.app",
  messagingSenderId: "173233747363",
  appId: "1:173233747363:web:0cef4c95425793532d5616"
};

export const firebaseConfigured = !Object.values(firebaseConfig).some((value) => String(value).startsWith("YOUR_"));
export default firebaseConfig;
