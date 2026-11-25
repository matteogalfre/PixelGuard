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
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppProvider } from '../state';
import { C } from '../ui/kit';

export default function Layout() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(C.bg).catch(() => {});
  }, []);

  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: C.bg }} />;

  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="light" />
        <Stack
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
