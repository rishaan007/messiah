import type { CapacitorConfig } from "@capacitor/cli";

const serverUrl = process.env.MESSIAH_MOBILE_WEB_URL;

const config: CapacitorConfig = {
  appId: "com.messiah.workspace",
  appName: "MESSIAH",
  webDir: "www",
  backgroundColor: "#090A0F",
  ...(serverUrl
    ? {
        server: {
          url: serverUrl,
          cleartext: serverUrl.startsWith("http://localhost"),
          allowNavigation: [new URL(serverUrl).host],
        },
      }
    : {
        server: {
          androidScheme: "https",
          iosScheme: "capacitor",
        },
      }),
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#090A0F",
    },
  },
};

export default config;
