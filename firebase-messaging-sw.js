importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCoWYFF9JxVxMFNlwnLzrulSkHmTjh46uY",
  authDomain: "handleliste-64ec3.firebaseapp.com",
  projectId: "handleliste-64ec3",
  storageBucket: "handleliste-64ec3.firebasestorage.app",
  messagingSenderId: "156616802673",
  appId: "1:156616802673:web:d7d84ed77ff471edd676d0"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "Handleliste";
  const options = {
    body: payload.notification?.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: payload.data || {}
  };

  self.registration.showNotification(title, options);
});
