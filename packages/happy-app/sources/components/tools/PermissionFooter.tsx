import React, { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Easing,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    useWindowDimensions,
    type StyleProp,
    type TextStyle,
    type ViewStyle,
} from 'react-native';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { isCodexSessionReadOnly } from '@/sync/codexV4Capabilities';
import type { Metadata } from '@/sync/storageTypes';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useIsTablet } from '@/utils/responsive';
import type { CodexRequestInteraction } from '@/sync/typesMessage';
import { RequestInteractionNotice } from './RequestInteractionNotice';
import {
    requestInteractionAllowsResponse,
    requestResponseLocalFailure,
    type RequestResponseLocalFailure,
} from './requestInteractionUi';

interface PermissionActionButtonProps {
    label: string;
    loading: boolean;
    disabled: boolean;
    onPress: () => void;
    activeOpacity: number;
    buttonStyle: StyleProp<ViewStyle>;
    contentStyle: StyleProp<ViewStyle>;
    textStyle: StyleProp<TextStyle>;
    ringStyle: StyleProp<ViewStyle>;
    ringColor: string;
    numberOfLines?: number;
}

const PermissionActionButton = React.memo(function PermissionActionButton({
    label,
    loading,
    disabled,
    onPress,
    activeOpacity,
    buttonStyle,
    contentStyle,
    textStyle,
    ringStyle,
    ringColor,
    numberOfLines = 1,
}: PermissionActionButtonProps) {
    const pulse = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (!loading) {
            pulse.stopAnimation();
            pulse.setValue(0);
            return;
        }

        pulse.setValue(0);
        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(pulse, { toValue: 1, duration: 720, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
                Animated.timing(pulse, { toValue: 0, duration: 720, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
            ]),
        );
        animation.start();
        return () => animation.stop();
    }, [loading, pulse]);

    const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.52] });

    return (
        <TouchableOpacity style={buttonStyle} onPress={onPress} disabled={disabled} activeOpacity={activeOpacity}>
            <View style={contentStyle}>
                <Text style={textStyle} numberOfLines={numberOfLines} ellipsizeMode="tail">{label}</Text>
            </View>
            {loading ? <Animated.View pointerEvents="none" style={[ringStyle, { borderColor: ringColor, opacity: ringOpacity }]} /> : null}
        </TouchableOpacity>
    );
});

interface PermissionFooterProps {
    permission: {
        id: string;
        status: 'pending' | 'approved' | 'denied' | 'canceled';
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    };
    sessionId: string;
    toolName: string;
    toolInput?: unknown;
    metadata?: Metadata | null;
    readOnly?: boolean;
    requestInteraction?: CodexRequestInteraction;
}

export const PermissionFooter: React.FC<PermissionFooterProps> = ({
    permission,
    sessionId,
    metadata,
    readOnly = false,
    requestInteraction,
}) => {
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const { height: windowHeight } = useWindowDimensions();
    const [loadingButton, setLoadingButton] = useState<'allow' | 'abort' | null>(null);
    const [loadingForSession, setLoadingForSession] = useState(false);
    const [localSubmissionPending, setLocalSubmissionPending] = useState(false);
    const [localFailure, setLocalFailure] = useState<RequestResponseLocalFailure | null>(null);
    const isCodexV4 = metadata?.flavor === 'codex' && metadata.codexSyncVersion === 4;
    const isPending = permission.status === 'pending';
    const isApproved = permission.status === 'approved';
    const isDenied = permission.status === 'denied';
    const isCodexApproved = isApproved && (permission.decision === 'approved' || !permission.decision);
    const isCodexApprovedForSession = isApproved && permission.decision === 'approved_for_session';
    const isCodexAborted = isDenied && permission.decision === 'abort';
    const canRespond = isPending
        && requestInteractionAllowsResponse(requestInteraction, localSubmissionPending);

    useEffect(() => {
        if (isPending && !requestInteraction?.commandId) return;
        setLocalSubmissionPending(false);
        setLocalFailure(null);
    }, [isPending, requestInteraction?.commandId]);

    const handleApprove = async () => {
        if (!canRespond || loadingButton !== null || loadingForSession) return;
        setLocalFailure(null);
        setLocalSubmissionPending(true);
        setLoadingButton('allow');
        try {
            await sessionAllow(sessionId, permission.id, 'approved');
        } catch (error) {
            console.error('Failed to approve Codex permission');
            const failure = requestResponseLocalFailure(error);
            setLocalFailure(failure);
            if (failure === 'retryable') setLocalSubmissionPending(false);
        } finally {
            setLoadingButton(null);
        }
    };

    const handleApproveForSession = async () => {
        if (!canRespond || loadingButton !== null || loadingForSession) return;
        setLocalFailure(null);
        setLocalSubmissionPending(true);
        setLoadingForSession(true);
        try {
            await sessionAllow(sessionId, permission.id, 'approved_for_session');
        } catch (error) {
            console.error('Failed to approve Codex permission for session');
            const failure = requestResponseLocalFailure(error);
            setLocalFailure(failure);
            if (failure === 'retryable') setLocalSubmissionPending(false);
        } finally {
            setLoadingForSession(false);
        }
    };

    const handleAbort = async () => {
        if (!canRespond || loadingButton !== null || loadingForSession) return;
        setLocalFailure(null);
        setLocalSubmissionPending(true);
        setLoadingButton('abort');
        try {
            await sessionDeny(sessionId, permission.id, 'abort');
        } catch (error) {
            console.error('Failed to stop Codex permission');
            const failure = requestResponseLocalFailure(error);
            setLocalFailure(failure);
            if (failure === 'retryable') setLocalSubmissionPending(false);
        } finally {
            setLoadingButton(null);
        }
    };

    if (readOnly || !isCodexV4 || isCodexSessionReadOnly(metadata)) return null;

    const styles = StyleSheet.create({
        container: { paddingHorizontal: 6, paddingTop: 4, paddingBottom: 8, justifyContent: 'center' },
        optionsScroll: { maxHeight: Math.min(260, Math.round(windowHeight * 0.35)) },
        buttonContainer: { flexDirection: 'column', gap: 7, alignItems: isTablet ? 'flex-end' : 'stretch' },
        button: {
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 7,
            backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 34,
            maxWidth: '100%',
            borderWidth: 1,
            borderColor: Platform.select({ web: theme.colors.textSecondary, default: theme.colors.divider }),
            flexShrink: 1,
            opacity: Platform.select({ web: 0.62, default: 1 }),
            overflow: 'hidden',
            position: 'relative',
        },
        buttonSelected: {
            backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surfaceHighest }),
            borderColor: Platform.select({ web: theme.colors.textSecondary, default: theme.colors.divider }),
            opacity: 1,
        },
        buttonInactive: { opacity: Platform.select({ web: 0.62, default: 0.52 }) },
        buttonContent: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 18, minWidth: 0 },
        buttonRing: { ...StyleSheet.absoluteFillObject, top: -1, right: -1, bottom: -1, left: -1, borderRadius: 8, borderWidth: 2 },
        buttonLoading: { opacity: 1 },
        buttonText: { fontSize: 14, lineHeight: 18, fontWeight: '400', color: theme.colors.text },
        buttonTextAction: { color: theme.colors.text, fontWeight: '500' },
        buttonTextSelected: { color: theme.colors.text, fontWeight: '500' },
        buttonForSession: { borderColor: Platform.select({ web: theme.colors.textSecondary, default: theme.colors.divider }) },
        buttonTextForSession: { color: theme.colors.text, fontWeight: '500' },
    });

    const renderPermissionButton = ({
        label,
        loading,
        onPress,
        disabled,
        buttonStyle,
        textStyle,
        numberOfLines = 1,
    }: {
        label: string;
        loading: boolean;
        onPress: () => void;
        disabled: boolean;
        buttonStyle: StyleProp<ViewStyle>;
        textStyle: StyleProp<TextStyle>;
        numberOfLines?: number;
    }) => (
        <PermissionActionButton
            label={label}
            loading={loading && isPending}
            onPress={onPress}
            disabled={disabled}
            activeOpacity={isPending ? 0.7 : 1}
            buttonStyle={[buttonStyle, loading && isPending ? styles.buttonLoading : null]}
            contentStyle={styles.buttonContent}
            textStyle={textStyle}
            ringStyle={styles.buttonRing}
            ringColor={theme.colors.text}
            numberOfLines={numberOfLines}
        />
    );

    return (
        <View style={styles.container}>
            <RequestInteractionNotice interaction={requestInteraction} localFailure={localFailure} />
            <ScrollView
                style={styles.optionsScroll}
                contentContainerStyle={styles.buttonContainer}
                nestedScrollEnabled
                showsVerticalScrollIndicator={false}
            >
                {renderPermissionButton({
                    label: t('common.yes'),
                    loading: loadingButton === 'allow',
                    onPress: handleApprove,
                    disabled: !canRespond || loadingButton !== null || loadingForSession,
                    buttonStyle: [styles.button, isCodexApproved && styles.buttonSelected, (isCodexAborted || isCodexApprovedForSession) && styles.buttonInactive],
                    textStyle: [styles.buttonText, isPending && styles.buttonTextAction, isCodexApproved && styles.buttonTextSelected],
                })}
                {renderPermissionButton({
                    label: t('codex.permissions.yesForSession'),
                    loading: loadingForSession,
                    onPress: handleApproveForSession,
                    disabled: !canRespond || loadingButton !== null || loadingForSession,
                    buttonStyle: [styles.button, styles.buttonForSession, isCodexApprovedForSession && styles.buttonSelected, (isCodexAborted || isCodexApproved) && styles.buttonInactive],
                    textStyle: [styles.buttonText, isPending && styles.buttonTextForSession, isCodexApprovedForSession && styles.buttonTextSelected],
                    numberOfLines: 2,
                })}
                {renderPermissionButton({
                    label: t('codex.permissions.stopAndExplain'),
                    loading: loadingButton === 'abort',
                    onPress: handleAbort,
                    disabled: !canRespond || loadingButton !== null || loadingForSession,
                    buttonStyle: [styles.button, isCodexAborted && styles.buttonSelected, (isCodexApproved || isCodexApprovedForSession) && styles.buttonInactive],
                    textStyle: [styles.buttonText, isPending && styles.buttonTextAction, isCodexAborted && styles.buttonTextSelected],
                    numberOfLines: 2,
                })}
            </ScrollView>
        </View>
    );
};
