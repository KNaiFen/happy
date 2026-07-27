export type MobileSendButtonVisuals = Readonly<{
    buttonStyle: Readonly<{
        backgroundColor: 'transparent';
        borderColor: string;
    }>;
    iconColor: string;
}>;

const ACTIVE_VISUALS: MobileSendButtonVisuals = {
    buttonStyle: {
        backgroundColor: 'transparent',
        borderColor: '#000000',
    },
    iconColor: '#000000',
};

const INACTIVE_VISUALS: MobileSendButtonVisuals = {
    buttonStyle: {
        backgroundColor: 'transparent',
        borderColor: '#C7C7CC',
    },
    iconColor: '#C7C7CC',
};

export function resolveMobileSendButtonVisuals(active: boolean): MobileSendButtonVisuals {
    return active ? ACTIVE_VISUALS : INACTIVE_VISUALS;
}
