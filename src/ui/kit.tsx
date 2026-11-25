import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, Path, Stop, LinearGradient as SvgGradient } from 'react-native-svg';

export const C = {
  bg: '#06090E',
  bg2: '#0B1220',
  surface: 'rgba(255,255,255,0.045)',
  surfaceHi: 'rgba(255,255,255,0.08)',
  line: 'rgba(255,255,255,0.09)',
  text: '#F2F6FA',
  muted: '#8B98A8',
  faint: '#566273',
  cyan: '#22C3F0',
  violet: '#7C6CFF',
  ok: '#37D69A',
  warn: '#FFB547',
  danger: '#FF6B72',
};

export const F = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semi: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  black: 'Inter_800ExtraBold',
};

export const GRADIENT = [C.cyan, C.violet] as const;

export function tap() {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function success() {
  if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** Fond de chaque écran : nuit profonde avec une lueur cyan en haut. */
export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient
        colors={['rgba(34,195,240,0.16)', 'rgba(124,108,255,0.06)', 'transparent']}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 0.55 }}
        style={StyleSheet.absoluteFill}
      />
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32, paddingHorizontal: 20, gap: 16 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingTop: insets.top + 8, paddingHorizontal: 20 }}>{children}</View>
      )}
    </View>
  );
}

export function Header({ title, subtitle, back = true, right }: { title: string; subtitle?: string; back?: boolean; right?: ReactNode }) {
  return (
    <View style={{ gap: 4, marginBottom: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }}>
        {back ? (
          <IconButton icon="arrow-left" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        ) : (
          <View />
        )}
        {right}
      </View>
      <Text style={t.h1}>{title}</Text>
      {subtitle ? <Text style={t.sub}>{subtitle}</Text> : null}
    </View>
  );
}

export function IconButton({ icon, onPress, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; onPress: () => void; label?: string }) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      accessibilityLabel={label ?? icon}
      hitSlop={8}
      style={({ pressed }) => [s.iconButton, pressed && { backgroundColor: C.surfaceHi }]}
    >
      <MaterialCommunityIcons name={icon} size={22} color={C.text} />
    </Pressable>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (!onPress) return <View style={[s.card, style]}>{children}</View>;
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [s.card, style, pressed && { backgroundColor: C.surfaceHi, transform: [{ scale: 0.985 }] }]}
    >
      {children}
    </Pressable>
  );
}

/** Grand bouton à dégradé, avec retour haptique. */
export function MainButton({
  label,
  onPress,
  icon,
  kind = 'gradient',
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof MaterialCommunityIcons.glyphMap;
  kind?: 'gradient' | 'ghost' | 'danger';
  disabled?: boolean;
  busy?: boolean;
}) {
  const fg = kind === 'ghost' ? C.text : '#041018';
  const inner = (
    <View style={s.buttonInner}>
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <MaterialCommunityIcons name={icon} size={20} color={fg} /> : null}
          <Text style={[s.buttonText, { color: fg }]}>{label}</Text>
        </>
      )}
    </View>
  );
  return (
    <Pressable
      disabled={disabled || busy}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [{ opacity: disabled ? 0.35 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}
    >
      {kind === 'gradient' ? (
        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.button}>
          {inner}
        </LinearGradient>
      ) : (
        <View style={[s.button, kind === 'ghost' ? s.ghost : { backgroundColor: C.danger }]}>{inner}</View>
      )}
    </Pressable>
  );
}

/** Anneau de progression animé, dégradé cyan vers violet. */
export function Ring({ value, size = 200, stroke = 14, children }: { value: number; size?: number; stroke?: number; children?: ReactNode }) {
  const anim = useRef(new Animated.Value(0)).current;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: Math.max(0, Math.min(1, value || 0)),
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [value, anim]);
  const clamped = Math.max(0, Math.min(1, value || 0));
  // Sur le web, Animated ajoute un attribut que le DOM refuse : on dessine sans animation.
  const web = Platform.OS === 'web';
  const offset = anim.interpolate({ inputRange: [0, 1], outputRange: [circ, 0] });
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={C.cyan} />
            <Stop offset="1" stopColor={C.violet} />
          </SvgGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.line} strokeWidth={stroke} fill="none" />
        {web ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke="url(#ring)"
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${circ} ${circ}`}
            strokeDashoffset={circ * (1 - clamped)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : (
          <AnimatedCircle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke="url(#ring)"
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${circ} ${circ}`}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </Svg>
      {children}
    </View>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Petite courbe de vitesse, pleine sous la ligne. */
export function Sparkline({ values, width, height = 44 }: { values: number[]; width: number; height?: number }) {
  if (values.length < 2 || width <= 0) return <View style={{ height }} />;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 6)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <Svg width={width} height={height}>
      <Defs>
        <SvgGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={C.cyan} stopOpacity={0.35} />
          <Stop offset="1" stopColor={C.cyan} stopOpacity={0} />
        </SvgGradient>
      </Defs>
      <Path d={area} fill="url(#spark)" />
      <Path d={line} stroke={C.cyan} strokeWidth={2} fill="none" strokeLinejoin="round" />
    </Svg>
  );
}

/** Vignette d'une photo du téléphone (ou un dégradé dans l'aperçu web). */
export function Thumb({ uri, size, radius = 12, style }: { uri?: string; size: number | `${number}%`; radius?: number; style?: StyleProp<ViewStyle> }) {
  const box = { width: size, height: size, borderRadius: radius, overflow: 'hidden' as const };
  if (!uri) {
    return (
      <LinearGradient colors={['#13324A', '#2A2457']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[box, { alignItems: 'center', justifyContent: 'center' }, style]}>
        <MaterialCommunityIcons name="image-outline" size={typeof size === 'number' ? size * 0.38 : 28} color="rgba(255,255,255,0.35)" />
      </LinearGradient>
    );
  }
  return <Image source={{ uri }} style={[box, style as object]} contentFit="cover" transition={150} recyclingKey={uri} />;
}

export function Bar({ value, height = 6 }: { value: number; height?: number }) {
  const pct = Math.max(0, Math.min(1, value || 0)) * 100;
  return (
    <View style={{ height, borderRadius: height, backgroundColor: C.line, overflow: 'hidden' }}>
      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ height, width: `${pct}%`, borderRadius: height }} />
    </View>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={s.segmented}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => {
              tap();
              onChange(o.value);
            }}
            style={[s.segment, on && { backgroundColor: C.surfaceHi, borderColor: C.line }]}
          >
            <Text style={[t.small, { color: on ? C.text : C.muted, fontFamily: F.semi }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Field(props: TextInputProps & { label: string; hint?: string }) {
  const { label, hint, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      <Text style={t.label}>{label}</Text>
      <TextInput
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
        style={[s.input, style]}
      />
      {hint ? <Text style={t.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, shadowColor: color, shadowOpacity: 0.8, shadowRadius: 6 }} />;
}

export function Step({ n, title, done, active, children }: { n: number; title: string; done?: boolean; active?: boolean; children?: ReactNode }) {
  return (
    <View style={[s.card, { gap: 14, opacity: active || done ? 1 : 0.45 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {done ? (
          <LinearGradient colors={GRADIENT} style={s.stepBadge}>
            <MaterialCommunityIcons name="check" size={16} color="#041018" />
          </LinearGradient>
        ) : (
          <View style={[s.stepBadge, { borderWidth: 1.5, borderColor: active ? C.cyan : C.line }]}>
            <Text style={[t.small, { color: active ? C.cyan : C.muted, fontFamily: F.bold }]}>{n}</Text>
          </View>
        )}
        <Text style={t.h3}>{title}</Text>
      </View>
      {active || done ? children : null}
    </View>
  );
}

export const t = StyleSheet.create({
  h1: { color: C.text, fontSize: 32, fontFamily: F.black, letterSpacing: -0.8 },
  h2: { color: C.text, fontSize: 22, fontFamily: F.bold, letterSpacing: -0.4 },
  h3: { color: C.text, fontSize: 17, fontFamily: F.semi },
  body: { color: C.text, fontSize: 15, fontFamily: F.regular, lineHeight: 21 },
  sub: { color: C.muted, fontSize: 15, fontFamily: F.regular, lineHeight: 21 },
  small: { color: C.muted, fontSize: 13, fontFamily: F.medium },
  label: { color: C.muted, fontSize: 12, fontFamily: F.semi, letterSpacing: 0.6, textTransform: 'uppercase' },
  hint: { color: C.faint, fontSize: 12.5, fontFamily: F.regular, lineHeight: 17 },
  mono: { color: C.muted, fontSize: 12, fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo' },
  big: { color: C.text, fontSize: 44, fontFamily: F.black, letterSpacing: -1.5 } as TextStyle,
});

export const s = StyleSheet.create({
  card: { backgroundColor: C.surface, borderRadius: 22, padding: 18, gap: 10, borderWidth: 1, borderColor: C.line },
  button: { borderRadius: 18, height: 58, justifyContent: 'center', paddingHorizontal: 20 },
  buttonInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  buttonText: { fontSize: 17, fontFamily: F.bold, letterSpacing: -0.2 },
  ghost: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface, borderWidth: 1, borderColor: C.line },
  segmented: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 14, padding: 4, gap: 4 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: 'transparent' },
  input: {
    backgroundColor: 'rgba(0,0,0,0.35)', color: C.text, borderRadius: 14, borderWidth: 1, borderColor: C.line,
    paddingHorizontal: 14, height: 50, fontSize: 16, fontFamily: F.medium,
  },
  stepBadge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
