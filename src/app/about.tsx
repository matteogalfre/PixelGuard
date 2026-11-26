import { MaterialCommunityIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { Linking, Platform, Pressable, Text, View } from 'react-native';

import { t } from '../i18n';
import { Icon, C, Card, F, Header, Screen, t as ty, tap } from '../ui/kit';
import { Logo } from '../ui/Logo';

const REPO = 'https://github.com/matteogalfre/PixelGuard';

/** Ce que l'appli embarque, avec sa licence. La partie SMB n'est pas la même selon le téléphone. */
const COMPONENTS: { name: string; license: string; url: string; only?: 'android' | 'ios' }[] = [
  { name: 'smbj', license: 'Apache-2.0', url: 'https://github.com/hierynomus/smbj', only: 'android' },
  { name: 'Bouncy Castle', license: 'MIT (Bouncy Castle Licence)', url: 'https://www.bouncycastle.org/licence.html', only: 'android' },
  { name: 'MBassador', license: 'MIT', url: 'https://github.com/bennidi/mbassador', only: 'android' },
  { name: 'asn-one', license: 'Apache-2.0', url: 'https://github.com/hierynomus/asn-one', only: 'android' },
  { name: 'SLF4J', license: 'MIT', url: 'https://www.slf4j.org/license.html', only: 'android' },
  { name: 'ZXing (lecture du QR)', license: 'Apache-2.0', url: 'https://github.com/journeyapps/zxing-android-embedded', only: 'android' },
  { name: 'libsmb2', license: 'LGPL-2.1', url: `${REPO}/tree/main/modules/pgnative/ios/libsmb2`, only: 'ios' },
  { name: 'expo-camera', license: 'MIT', url: 'https://github.com/expo/expo', only: 'ios' },
  { name: 'React Native', license: 'MIT', url: 'https://github.com/facebook/react-native' },
  { name: 'Expo', license: 'MIT', url: 'https://github.com/expo/expo' },
  { name: 'React Native Reanimated, SVG, Screens', license: 'MIT', url: 'https://github.com/software-mansion' },
  { name: 'Inter', license: 'SIL OFL 1.1', url: 'https://github.com/rsms/inter' },
  { name: 'Material Design Icons', license: 'Pictogrammers Free License', url: 'https://pictogrammers.com/docs/general/license/' },
];

function open(url: string) {
  tap();
  Linking.openURL(url).catch(() => {});
}

function LinkRow({ icon, label, url }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string; url: string }) {
  return (
    <Pressable
      onPress={() => open(url)}
      accessibilityRole="link"
      accessibilityLabel={label}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, opacity: pressed ? 0.6 : 1 })}
    >
      <Icon name={icon} size={22} color={C.accent} />
      <Text style={[ty.body, { flex: 1 }]}>{label}</Text>
      <Icon name="open-in-new" size={18} color={C.muted} />
    </Pressable>
  );
}

export default function About() {
  const version = Constants.expoConfig?.version ?? '?';
  const components = COMPONENTS.filter((c) => !c.only || c.only === Platform.OS);
  return (
    <Screen>
      <Header title={t.aboutTitle} />

      <View style={{ alignItems: 'center', gap: 8, marginVertical: 8 }}>
        <Logo size={72} />
        <Text style={[ty.h2, { fontFamily: F.black }]}>PixelGuard</Text>
        <Text style={ty.small}>{t.aboutVersion(version)}</Text>
        <Text style={[ty.sub, { textAlign: 'center' }]}>{t.aboutTagline}</Text>
      </View>

      <Card style={{ gap: 2 }}>
        <Text style={ty.label}>{t.aboutHelp}</Text>
        <LinkRow icon="bug-outline" label={t.aboutIssue} url={`${REPO}/issues`} />
        <LinkRow icon="github" label={t.aboutSource} url={REPO} />
      </Card>

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="shield-lock-outline" size={20} color={C.ok} />
          <Text style={ty.h3}>{t.aboutPrivacyTitle}</Text>
        </View>
        <Text style={ty.body}>{t.aboutPrivacy}</Text>
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={ty.label}>{t.aboutLicenses}</Text>
        <Pressable onPress={() => open(`${REPO}/blob/main/LICENSE`)} accessibilityRole="link" style={{ gap: 2, minHeight: 44, justifyContent: 'center' }}>
          <Text style={ty.h3}>PixelGuard</Text>
          <Text style={ty.small}>{t.aboutOwnLicense}</Text>
        </Pressable>
        {components.map((c) => (
          <Pressable
            key={c.name}
            onPress={() => open(c.url)}
            accessibilityRole="link"
            accessibilityLabel={`${c.name}, ${c.license}`}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={[ty.body, { flex: 1 }]}>{c.name}</Text>
            <Text style={[ty.small, { textAlign: 'right', flexShrink: 1 }]}>{c.license}</Text>
          </Pressable>
        ))}
        {Platform.OS === 'ios' ? <Text style={ty.hint}>{t.aboutLgpl}</Text> : null}
      </Card>
    </Screen>
  );
}
