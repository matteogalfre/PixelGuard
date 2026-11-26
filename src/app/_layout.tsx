import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppProvider } from '../state';
import { applyTheme, C } from '../ui/kit';

export default function Layout() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });
  // Clair ou sombre comme le téléphone. Les couleurs changent avant de dessiner les écrans.
  const theme = useColorScheme() === 'light' ? 'light' : 'dark';
  applyTheme(theme);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(C.bg).catch(() => {});
  }, [theme]);

  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: C.bg }} />;

  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style={theme === 'light' ? 'dark' : 'light'} />
        {/* Nouvelle clé au changement de thème : les écrans se redessinent avec les nouvelles couleurs. */}
        <Stack
          key={theme}
          screenOptions={{
            headerShown: false,
            animation: 'slide_from_right',
            contentStyle: { backgroundColor: C.bg },
          }}
        />
      </AppProvider>
    </SafeAreaProvider>
  );
}
