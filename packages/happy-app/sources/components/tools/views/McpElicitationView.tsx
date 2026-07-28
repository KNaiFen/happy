import * as React from 'react';
import {
    ActivityIndicator,
    Pressable,
    Switch,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import {
    initialMcpElicitationValues,
    formatMcpElicitationValue,
    parseMcpElicitation,
    parseMcpElicitationJson,
    parseMcpElicitationResponse,
    serializeMcpElicitationValues,
    type McpElicitationField,
    type McpElicitationValues,
} from '@/sync/mcpElicitation';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { ToolSectionView } from '../ToolSectionView';
import type { ToolViewProps } from './_all';
import { isCodexSessionReadOnly } from '@/sync/codexV4Capabilities';

export const McpElicitationView = React.memo<ToolViewProps>(({ tool, sessionId, metadata, readOnly = false }) => {
    const { theme } = useUnistyles();
    const parsed = React.useMemo(() => parseMcpElicitation(tool.input), [tool.input]);
    const fields = parsed?.mode === 'form' ? parsed.fields : [];
    const [values, setValues] = React.useState<McpElicitationValues>(() => initialMcpElicitationValues(fields));
    const [jsonText, setJsonText] = React.useState(() => parsed?.mode === 'json' ? parsed.initialJson : '{}');
    const [submitting, setSubmitting] = React.useState<'accept' | 'cancel' | null>(null);
    const [submittedAction, setSubmittedAction] = React.useState<'accept' | 'cancel' | null>(null);
    const response = React.useMemo(() => parseMcpElicitationResponse(tool.result), [tool.result]);
    const formContent = React.useMemo(
        () => parsed?.mode === 'form' ? serializeMcpElicitationValues(parsed.fields, values) : null,
        [parsed, values],
    );
    const jsonContent = React.useMemo(
        () => parsed?.mode === 'json' ? parseMcpElicitationJson(jsonText) : null,
        [jsonText, parsed],
    );
    const interactionReadOnly = readOnly || isCodexSessionReadOnly(metadata);
    const canInteract = !interactionReadOnly && tool.state === 'running' && submittedAction === null;
    const canSubmit = parsed?.mode === 'url'
        || (parsed?.mode === 'form' && formContent !== null)
        || (parsed?.mode === 'json' && jsonContent !== null);

    const submit = React.useCallback(async () => {
        if (interactionReadOnly || !sessionId || !tool.permission?.id || !parsed || !canInteract || !canSubmit || submitting) return;
        setSubmitting('accept');
        try {
            const content = parsed.mode === 'form'
                ? formContent ?? undefined
                : parsed.mode === 'json'
                    ? jsonContent ?? undefined
                    : undefined;
            await sessionAllow(sessionId, tool.permission.id, undefined, undefined, 'approved', content);
            setSubmittedAction('accept');
        } finally {
            setSubmitting(null);
        }
    }, [interactionReadOnly, canInteract, canSubmit, formContent, jsonContent, parsed, sessionId, submitting, tool.permission?.id]);

    const cancel = React.useCallback(async () => {
        if (interactionReadOnly || !sessionId || !tool.permission?.id || !canInteract || submitting) return;
        setSubmitting('cancel');
        try {
            await sessionDeny(sessionId, tool.permission.id, undefined, undefined, 'abort');
            setSubmittedAction('cancel');
        } finally {
            setSubmitting(null);
        }
    }, [interactionReadOnly, canInteract, sessionId, submitting, tool.permission?.id]);

    if (!parsed) return null;
    if (submittedAction || tool.state === 'completed') {
        const action = response?.action ?? submittedAction;
        const content = response?.action === 'accept'
            ? response.content
            : submittedAction === 'accept'
                ? parsed.mode === 'form' ? formContent : parsed.mode === 'json' ? jsonContent : null
                : null;
        const contentRecord = content && typeof content === 'object' && !Array.isArray(content)
            ? content as Record<string, unknown>
            : {};
        return (
            <ToolSectionView>
                <View style={styles.container}>
                    {parsed.message ? <Text style={styles.message}>{parsed.message}</Text> : null}
                    {action === 'cancel' || action === 'decline'
                        ? <Text style={styles.resultStatus}>{t('common.cancel')}</Text>
                        : null}
                    {action === 'accept' && parsed.mode === 'form'
                        ? parsed.fields.map((field) => (
                            <View key={field.key} style={styles.resultRow}>
                                <Text style={styles.resultLabel}>{field.title}:</Text>
                                <Text style={styles.resultValue}>{formatMcpElicitationValue(contentRecord[field.key])}</Text>
                            </View>
                        ))
                        : null}
                    {action === 'accept' && parsed.mode === 'json' && content !== null
                        ? <Text style={styles.jsonResult}>{JSON.stringify(content, null, 2)}</Text>
                        : null}
                    {action === 'accept' && parsed.mode === 'url' ? (
                        <Pressable
                            accessibilityRole="link"
                            accessibilityLabel={parsed.url}
                            onPress={() => void openExternalUrl(parsed.url)}
                            style={({ pressed }) => [styles.link, pressed && styles.pressed]}
                        >
                            <Ionicons name="open-outline" size={18} color={theme.colors.textLink} />
                            <Text style={styles.linkText} numberOfLines={2}>{parsed.url}</Text>
                        </Pressable>
                    ) : null}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {parsed.message ? <Text style={styles.message}>{parsed.message}</Text> : null}
                {parsed.mode === 'form' ? parsed.fields.map((field) => (
                    <McpField
                        key={field.key}
                        field={field}
                        value={values[field.key]}
                        disabled={!canInteract}
                        onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
                    />
                )) : null}
                {parsed.mode === 'json' ? (
                    <TextInput
                        accessibilityLabel={parsed.message}
                        editable={canInteract}
                        multiline
                        value={jsonText}
                        onChangeText={setJsonText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={[styles.jsonInput, jsonContent === null && styles.invalidInput]}
                    />
                ) : null}
                {parsed.mode === 'url' ? (
                    <Pressable
                        accessibilityRole="link"
                        accessibilityLabel={parsed.url}
                        disabled={!canInteract}
                        onPress={() => void openExternalUrl(parsed.url)}
                        style={({ pressed }) => [styles.link, pressed && styles.pressed]}
                    >
                        <Ionicons name="open-outline" size={18} color={theme.colors.textLink} />
                        <Text style={styles.linkText} numberOfLines={2}>{parsed.url}</Text>
                    </Pressable>
                ) : null}
                {canInteract ? (
                    <View style={styles.actions}>
                        <TouchableOpacity
                            style={styles.cancelButton}
                            disabled={submitting !== null}
                            onPress={cancel}
                        >
                            {submitting === 'cancel'
                                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                : <Text style={styles.cancelText}>{t('common.cancel')}</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.submitButton, (!canSubmit || submitting !== null) && styles.disabled]}
                            disabled={!canSubmit || submitting !== null}
                            onPress={submit}
                        >
                            {submitting === 'accept'
                                ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                                : <Text style={styles.submitText}>{t('tools.askUserQuestion.submit')}</Text>}
                        </TouchableOpacity>
                    </View>
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const McpField = React.memo((props: {
    field: McpElicitationField;
    value: string | boolean | string[] | undefined;
    disabled: boolean;
    onChange: (value: string | boolean | string[]) => void;
}) => {
    const { field, value, disabled, onChange } = props;
    return (
        <View style={styles.field}>
            <Text style={styles.label}>{field.title}</Text>
            {field.description ? <Text style={styles.description}>{field.description}</Text> : null}
            {field.kind === 'boolean' ? (
                <Switch
                    accessibilityLabel={field.title}
                    disabled={disabled}
                    value={value === true}
                    onValueChange={onChange}
                />
            ) : field.kind === 'single' || field.kind === 'multi' ? (
                <View style={styles.options}>
                    {field.options.map((option) => {
                        const selected = field.kind === 'multi'
                            ? Array.isArray(value) && value.includes(option.value)
                            : value === option.value;
                        return (
                            <Pressable
                                key={option.value}
                                accessibilityRole={field.kind === 'multi' ? 'checkbox' : 'radio'}
                                accessibilityState={{ checked: selected, disabled }}
                                disabled={disabled}
                                onPress={() => {
                                    if (field.kind === 'single') {
                                        onChange(option.value);
                                        return;
                                    }
                                    const current = Array.isArray(value) ? value : [];
                                    onChange(selected
                                        ? current.filter((entry) => entry !== option.value)
                                        : [...current, option.value]);
                                }}
                                style={({ pressed }) => [
                                    styles.option,
                                    selected && styles.optionSelected,
                                    pressed && styles.pressed,
                                ]}
                            >
                                <Ionicons
                                    name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                                    size={18}
                                    style={styles.optionIcon}
                                />
                                <Text style={styles.optionText}>{option.label}</Text>
                            </Pressable>
                        );
                    })}
                </View>
            ) : (
                <TextInput
                    accessibilityLabel={field.title}
                    editable={!disabled}
                    value={typeof value === 'string' ? value : ''}
                    onChangeText={onChange}
                    keyboardType={field.kind === 'number' || field.kind === 'integer' ? 'numeric' : 'default'}
                    autoCapitalize="none"
                    style={styles.input}
                />
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 14,
    },
    message: {
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 21,
    },
    resultStatus: {
        color: theme.colors.textSecondary,
        fontSize: 14,
    },
    resultRow: {
        flexDirection: 'row',
        gap: 8,
    },
    resultLabel: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        fontWeight: '600',
    },
    resultValue: {
        color: theme.colors.text,
        fontSize: 13,
        flex: 1,
    },
    jsonResult: {
        color: theme.colors.text,
        fontFamily: 'monospace',
        fontSize: 13,
    },
    field: {
        gap: 6,
    },
    label: {
        color: theme.colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    description: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    input: {
        minHeight: 44,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        paddingHorizontal: 12,
        color: theme.colors.text,
        backgroundColor: theme.colors.surface,
    },
    jsonInput: {
        minHeight: 132,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        padding: 12,
        color: theme.colors.text,
        backgroundColor: theme.colors.surface,
        fontFamily: 'monospace',
        textAlignVertical: 'top',
    },
    invalidInput: {
        borderColor: theme.colors.warning,
    },
    options: {
        gap: 6,
    },
    option: {
        minHeight: 42,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        paddingHorizontal: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    optionSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.surfaceHigh,
    },
    optionIcon: {
        color: theme.colors.radio.active,
    },
    optionText: {
        color: theme.colors.text,
        fontSize: 14,
        flex: 1,
    },
    link: {
        minHeight: 44,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    linkText: {
        color: theme.colors.textLink,
        fontSize: 14,
        flex: 1,
    },
    pressed: {
        opacity: 0.72,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 10,
    },
    cancelButton: {
        minHeight: 44,
        minWidth: 88,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    cancelText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        fontWeight: '600',
    },
    submitButton: {
        minHeight: 44,
        minWidth: 112,
        borderRadius: 8,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
    },
    submitText: {
        color: theme.colors.button.primary.tint,
        fontSize: 14,
        fontWeight: '600',
    },
    disabled: {
        opacity: 0.5,
    },
}));
