// Service Worker — קבלת Web Push והצגת התראה מערכתית.
// נרשם ע"י PushOptIn. אינו מבצע caching (אין כאן PWA offline).

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "התראה", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "מערכת משאבי אנוש";
  const options = {
    body: data.body || "",
    icon: "/logo-light.png",
    badge: "/logo-light.png",
    dir: "rtl",
    lang: "he",
    data: { link: data.link || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // אם חלון פתוח — ממקדים אותו ומנווטים; אחרת פותחים חדש.
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) client.navigate(link);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(link);
    }),
  );
});
