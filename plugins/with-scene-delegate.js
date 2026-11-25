// iOS 27 refuse de lancer une appli sans cycle de vie par scènes (UIScene). Expo 57 fournit
// ExpoAppSceneDelegate, mais le modèle de prebuild ne l'active pas encore : on le fait ici.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

function withScenePlist(config) {
  return withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
        ],
      },
    };
    return c;
  });
}

function withSceneAppDelegate(config) {
  return withAppDelegate(config, (c) => {
    if (c.modResults.language !== 'swift') throw new Error('with-scene-delegate : AppDelegate Swift attendu');
    let src = c.modResults.contents;
    if (!src.includes('ExpoReactNativeFactoryProvider')) {
      src = src.replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
    }
    // La fenêtre et le démarrage de React Native passent dans le délégué de scène.
    src = src.replace(/\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/, '\n');
    if (!src.includes('ExpoReactNativeFactoryProvider') || src.includes('factory.startReactNative(')) {
      throw new Error("with-scene-delegate : l'AppDelegate généré a changé, à revoir");
    }
    c.modResults.contents = src;
    return c;
  });
}

module.exports = (config) => withSceneAppDelegate(withScenePlist(config));
