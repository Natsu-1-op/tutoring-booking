// firebase-config.js
const firebaseConfig = {
  apiKey: "AIzaSyB6EbZElw7ahDN5rOK-keWlgr9JInVbnN4",
  authDomain: "class-optic.firebaseapp.com",
  projectId: "class-optic",
  storageBucket: "class-optic.firebasestorage.app",
  messagingSenderId: "859111669333",
  appId: "1:859111669333:web:ec5cea5bd22dc0c495dedc",
  databaseURL: "https://class-optic-default-rtdb.asia-southeast1.firebasedatabase.app" 
};

// 初始化 Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();