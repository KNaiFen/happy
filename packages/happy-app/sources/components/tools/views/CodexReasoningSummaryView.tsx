import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import type { ToolViewProps } from './_all';

export const CodexReasoningSummaryView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const content = typeof tool.result === 'object'
        && tool.result !== null
        && 'content' in tool.result
        && typeof tool.result.content === 'string'
        ? tool.result.content
        : '';
    if (!content) return null;
    return (
        <View style={styles.container}>
            <MarkdownView markdown={content} sessionId={sessionId} />
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        paddingHorizontal: 12,
        paddingBottom: 10,
        maxWidth: '100%',
    },
}));
