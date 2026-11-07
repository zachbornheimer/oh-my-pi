module.exports = function (api) {
    api.cache(true);
    return {
        presets: [
            [
                'babel-preset-expo',
                {
                    unstable_transformImportMeta: true,
                },
            ],
            'nativewind/babel',
        ],
        plugins: [
            [
                'module-resolver',
                {
                    root: ['./'],
                    alias: {
                        '@': './src',
                        '@components': './src/components',
                        '@lib': './src/lib',
                        '@theme': './theme',
                        '@hooks': './src/hooks',
                        '@Input': './src/Input',
                        '@atoms': './src/atoms',
                        '@src': './src',
                        '@constants': './src/constants',
                        '@locales': './src/locales',
                        '@services': './src/services',
                        '@assets': './assets',
                        '@events': './src/events',
                        '@factories': './src/factories',
                        '@sah-ui': './src/sah-ui',
                        '@ui': './src/ui',
                    },
                },
            ],
        ],
    };
};
