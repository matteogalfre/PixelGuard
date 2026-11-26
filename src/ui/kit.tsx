import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef, type ReactNode } from 'react';
import type React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Appearance,
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

import { t as tr } from '../i18n';

// Deux palettes aux mêmes noms : l'appli suit le thème clair ou sombre du téléphone.
const DARK = {
  bg: '#07060F',
  bg2: '#0E0B1E',
  surface: 'rgba(255,255,255,0.045)',
  surfaceHi: 'rgba(255,255,255,0.08)',
  line: 'rgba(255,255,255,0.09)',
  text: '#F2F6FA',
  muted: '#8B98A8',
  /** Assez clair pour rester lisible (contraste 5:1 sur le fond), même en petit. */
  faint: '#7A8798',
  /** Violet du logo, éclairci pour rester lisible sur fond nuit. */
  accent: '#9C8CFF',
  /** Violet profond, bas du dégradé. */
  accent2: '#6A55F5',
  ok: '#37D69A',
  warn: '#FFB547',
  danger: '#FF6B72',
  /** Fond d'un choix sélectionné. */
  selected: 'rgba(124,108,255,0.16)',
  /** Creux : champs, code à copier, listes dans une carte. */
  inset: 'rgba(0,0,0,0.32)',
  glow1: 'rgba(124,108,255,0.22)',
  glow2: 'rgba(176,108,255,0.07)',
  okLine: 'rgba(55,214,154,0.35)',
  warnLine: 'rgba(255,181,71,0.35)',
  dangerLine: 'rgba(255,107,114,0.4)',
  dangerBg: 'rgba(255,107,114,0.08)',
  /** Barre posée en bas d'un écran, au-dessus du contenu. */
  bar: 'rgba(7,6,15,0.94)',
  thumb1: '#2A2160',
  thumb2: '#16122E',
};

// Contrastes vérifiés : texte 17:1, secondaire 6:1, pâle 4,8:1, violet 5,7:1 sur le fond.
const LIGHT: typeof DARK = {
  bg: '#F6F5FB',
  bg2: '#ECEAF7',
  surface: '#FFFFFF',
  surfaceHi: 'rgba(40,30,110,0.07)',
  line: 'rgba(30,24,80,0.12)',
  text: '#15122B',
  muted: '#555C6B',
  faint: '#666D7C',
  accent: '#5B47E0',
  accent2: '#6A55F5',
  ok: '#0A7A4F',
  warn: '#A65F00',
  danger: '#C8303A',
  selected: 'rgba(91,71,224,0.12)',
  inset: 'rgba(30,24,80,0.05)',
  glow1: 'rgba(124,108,255,0.16)',
  glow2: 'rgba(176,108,255,0.05)',
  okLine: 'rgba(10,122,79,0.35)',
  warnLine: 'rgba(166,95,0,0.35)',
  dangerLine: 'rgba(200,48,58,0.35)',
  dangerBg: 'rgba(200,48,58,0.06)',
  bar: 'rgba(246,245,251,0.95)',
  thumb1: '#DCD7FA',
  thumb2: '#ECEAF7',
};

export type Theme = 'light' | 'dark';
let theme: Theme = Appearance.getColorScheme() === 'light' ? 'light' : 'dark';

/** Les couleurs du thème en cours. L'objet reste le même, ses valeurs changent avec le thème. */
export const C = { ...(theme === 'light' ? LIGHT : DARK) };

export function currentTheme(): Theme {
  return theme;
}

export const F = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semi: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  black: 'Inter_800ExtraBold',
};

export const GRADIENT = ['#8F7DFF', '#6A55F5'] as const;

/**
 * Une icône décorative : le lecteur d'écran la saute (le texte ou le nom du bouton à côté dit
 * déjà tout ; sans ça, il s'arrête sur un caractère vide de la police d'icônes).
 */
export function Icon(props: React.ComponentProps<typeof MaterialCommunityIcons>) {
  return <MaterialCommunityIcons accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" {...props} />;
}

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
        colors={[C.glow1, C.glow2, 'transparent']}
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
          <IconButton icon="arrow-left" label={tr.back} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        ) : (
          <View />
        )}
        {right}
      </View>
      <Text style={t.h1} accessibilityRole="header" maxFontSizeMultiplier={1.6}>{title}</Text>
      {subtitle ? <Text style={t.sub}>{subtitle}</Text> : null}
    </View>
  );
}

/** Bouton rond à icône : `label` est ce que lit le lecteur d'écran. */
export function IconButton({ icon, onPress, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; onPress: () => void; label: string }) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [s.iconButton, pressed && { backgroundColor: C.surfaceHi }]}
    >
      <Icon name={icon} size={22} color={C.text} />
    </Pressable>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (!onPress) return <View style={[s.card, style]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
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
  const fg = kind === 'ghost' ? C.text : '#FFFFFF';
  const inner = (
    <View style={s.buttonInner}>
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={20} color={fg} /> : null}
          <Text style={[s.buttonText, { color: fg }]}>{label}</Text>
        </>
      )}
    </View>
  );
  return (
    <Pressable
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
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

/**
 * Fin de sauvegarde réussie : une coche qui apparaît en rebondissant. Immobile si le téléphone
 * demande de réduire les animations ; le lecteur d'écran lit le titre et le détail.
 */
export function DoneCheck({ title, detail }: { title: string; detail: string }) {
  const scale = useRef(new Animated.Value(0.4)).current;
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let live = true;
    const native = Platform.OS !== 'web';
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => true)
      .then((reduce) => {
        if (!live) return;
        if (reduce) {
          scale.setValue(1);
          fade.setValue(1);
          return;
        }
        Animated.parallel([
          Animated.spring(scale, { toValue: 1, friction: 5, tension: 140, useNativeDriver: native }),
          Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: native }),
        ]).start();
      });
    return () => {
      live = false;
    };
  }, [scale, fade]);
  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${detail}`}
      accessibilityLiveRegion="polite"
      style={[s.card, { alignItems: 'center', gap: 8, paddingVertical: 22, borderColor: C.okLine }]}
    >
      <Animated.View style={{ opacity: fade, transform: [{ scale }] }}>
        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="check-bold" size={40} color="#FFFFFF" />
        </LinearGradient>
      </Animated.View>
      <Text style={[t.h2, { color: C.text, textAlign: 'center' }]}>{title}</Text>
      <Text style={[t.small, { textAlign: 'center' }]}>{detail}</Text>
    </View>
  );
}

/** Anneau de progression animé, dégradé cyan vers violet. */
/** `label` : ce que lit le lecteur d'écran (sinon il ne voit qu'un dessin). */
export function Ring({ value, size = 200, stroke = 14, label, children }: { value: number; size?: number; stroke?: number; label?: string; children?: ReactNode }) {
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
    <View
      accessible={!!label}
      accessibilityRole={label ? 'progressbar' : undefined}
      accessibilityLabel={label}
      accessibilityValue={label ? { min: 0, max: 100, now: Math.round(clamped * 100) } : undefined}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={C.accent} />
            <Stop offset="1" stopColor={C.accent2} />
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
          <Stop offset="0" stopColor={C.accent} stopOpacity={0.35} />
          <Stop offset="1" stopColor={C.accent} stopOpacity={0} />
        </SvgGradient>
      </Defs>
      <Path d={area} fill="url(#spark)" />
      <Path d={line} stroke={C.accent} strokeWidth={2} fill="none" strokeLinejoin="round" />
    </Svg>
  );
}

/** Vignette d'une photo du téléphone (ou un dégradé dans l'aperçu web). */
export function Thumb({ uri, size, radius = 12, style }: { uri?: string; size: number | `${number}%`; radius?: number; style?: StyleProp<ViewStyle> }) {
  const hidden = { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
  const box = { width: size, height: size, borderRadius: radius, overflow: 'hidden' as const };
  if (!uri) {
    return (
      <LinearGradient {...hidden} colors={[C.thumb1, C.thumb2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[box, { alignItems: 'center', justifyContent: 'center' }, style]}>
        <Icon name="image-outline" size={typeof size === 'number' ? size * 0.38 : 28} color={C.faint} />
      </LinearGradient>
    );
  }
  return <Image {...hidden} source={{ uri }} style={[box, style as object]} contentFit="cover" transition={150} recyclingKey={uri} />;
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
    <View style={s.segmented} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on, checked: on }}
            onPress={() => {
              tap();
              onChange(o.value);
            }}
            style={[s.segment, on && { backgroundColor: C.surfaceHi, borderColor: C.line }]}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[t.small, { color: on ? C.text : C.muted, fontFamily: F.semi }]}>
              {o.label}
            </Text>
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
            <Icon name="check" size={16} color="#FFFFFF" />
          </LinearGradient>
        ) : (
          <View style={[s.stepBadge, { borderWidth: 1.5, borderColor: active ? C.accent : C.line }]}>
            <Text style={[t.small, { color: active ? C.accent : C.muted, fontFamily: F.bold }]}>{n}</Text>
          </View>
        )}
        <Text style={t.h3}>{title}</Text>
      </View>
      {active || done ? children : null}
    </View>
  );
}

/** Garde les noms des styles et vérifie chaque style (comme StyleSheet.create, sans le figer). */
const styles = <T extends Record<string, TextStyle>>(o: T): T => o;

function makeText(C: typeof DARK) {
  return styles({
    h1: { color: C.text, fontSize: 32, fontFamily: F.black, letterSpacing: -0.8 },
    h2: { color: C.text, fontSize: 22, fontFamily: F.bold, letterSpacing: -0.4 },
    h3: { color: C.text, fontSize: 17, fontFamily: F.semi },
    body: { color: C.text, fontSize: 15, fontFamily: F.regular, lineHeight: 21 },
    sub: { color: C.muted, fontSize: 15, fontFamily: F.regular, lineHeight: 21 },
    small: { color: C.muted, fontSize: 14, fontFamily: F.medium },
    label: { color: C.muted, fontSize: 12.5, fontFamily: F.semi, letterSpacing: 0.6, textTransform: 'uppercase' },
    hint: { color: C.faint, fontSize: 13.5, fontFamily: F.regular, lineHeight: 19 },
    mono: { color: C.muted, fontSize: 12, fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo' },
    big: { color: C.text, fontSize: 44, fontFamily: F.black, letterSpacing: -1.5 },
  });
}

function makeBox(C: typeof DARK) {
  return styles({
    card: { backgroundColor: C.surface, borderRadius: 22, padding: 18, gap: 10, borderWidth: 1, borderColor: C.line },
    // Hauteur minimale, pas fixe : avec une grande taille de texte, le bouton grandit au lieu de couper.
    button: { borderRadius: 18, minHeight: 58, paddingVertical: 12, justifyContent: 'center', paddingHorizontal: 20 },
    buttonInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, flexWrap: 'wrap' },
    buttonText: { fontSize: 17, fontFamily: F.bold, letterSpacing: -0.2 },
    ghost: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line },
    iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface, borderWidth: 1, borderColor: C.line },
    segmented: { flexDirection: 'row', backgroundColor: C.inset, borderRadius: 14, padding: 4, gap: 4 },
    // Chaque bouton prend la largeur de son texte (le reste est partagé) : « Mois dernier » tient sur une ligne.
    segment: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingVertical: 9, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: 'transparent' },
    input: {
      backgroundColor: C.inset, color: C.text, borderRadius: 14, borderWidth: 1, borderColor: C.line,
      paddingHorizontal: 14, minHeight: 50, paddingVertical: 12, fontSize: 16, fontFamily: F.medium,
    },
    stepBadge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  });
}

/** Les styles de texte et de boîtes du thème en cours (mêmes objets, valeurs recalculées). */
export const t = makeText(C);
export const s = makeBox(C);

/** Passe au thème clair ou sombre. L'appelant fait ensuite redessiner les écrans. */
export function applyTheme(next: Theme): void {
  if (next === theme) return;
  theme = next;
  Object.assign(C, next === 'light' ? LIGHT : DARK);
  Object.assign(t, makeText(C));
  Object.assign(s, makeBox(C));
}

