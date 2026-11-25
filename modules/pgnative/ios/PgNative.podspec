Pod::Spec.new do |s|
  s.name           = 'PgNative'
  s.version        = '0.1.0'
  s.summary        = 'PixelGuard : galerie (PhotoKit) et dossier partagé du PC (SMB 2/3 via libsmb2)'
  s.description    = s.summary
  s.license        = 'GPL-3.0-or-later'
  s.author         = 'PixelGuard'
  s.homepage       = 'https://github.com/matteogalfre/PixelGuard-mobile'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/matteogalfre/PixelGuard-mobile.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Photos', 'CryptoKit'

  # libsmb2 (LGPL-2.1+) est compilé avec le module : seul PgSmb.h est visible du Swift.
  s.source_files = '*.{h,c,swift}', 'libsmb2/lib/*.{c,h}', 'libsmb2/include/*.h', 'libsmb2/include/apple/*.h', 'libsmb2/include/smb2/*.h'
  s.public_header_files = 'PgSmb.h'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/libsmb2/include" "$(PODS_TARGET_SRCROOT)/libsmb2/include/apple" "$(PODS_TARGET_SRCROOT)/libsmb2/include/smb2" "$(PODS_TARGET_SRCROOT)/libsmb2/lib"',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) HAVE_CONFIG_H=1 _U_=__attribute__((unused))',
    'GCC_WARN_INHIBIT_ALL_WARNINGS' => 'YES',
  }
end
