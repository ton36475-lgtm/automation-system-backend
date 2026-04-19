/**
 * Main Dashboard Component
 * 
 * Features:
 * - Real-time metrics display
 * - Workflow execution monitoring
 * - Analytics visualization
 * - User activity tracking
 * - Responsive design for mobile & desktop
 */

'use client';

import React, { useEffect, useState } from 'react';
import {
    AreaChart,
    Area,
    BarChart,
    Bar,
    LineChart,
    Line,
    PieChart,
    Pie,
    Cell,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer
} from 'recharts';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import clsx from 'clsx';

interface MetricCard {
    title: string;
    value: number | string;
    change?: number;
    trend?: 'up' | 'down';
    icon?: React.ReactNode;
}

interface DashboardData {
    metrics: MetricCard[];
    executionTrends: Array<{ time: string; count: number }>;
    eventDistribution: Array<{ name: string; value: number }>;
    recentExecutions: Array<{
        id: string;
        workflow: string;
        status: 'completed' | 'failed' | 'running';
        duration: number;
        timestamp: string;
    }>;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export const Dashboard: React.FC = () => {
    const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
    const [loading, setLoading] = useState(true);

    // Fetch dashboard data
    const { data: summaryData } = useQuery({
        queryKey: ['dashboard-summary'],
        queryFn: async () => {
            const response = await axios.get(`${API_BASE_URL}/api/v1/analytics/summary`, {
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                }
            });
            return response.data.data;
        },
        refetchInterval: 5000 // Refresh every 5 seconds
    });

    // Fetch execution trends
    const { data: trendsData } = useQuery({
        queryKey: ['execution-trends'],
        queryFn: async () => {
            const response = await axios.get(`${API_BASE_URL}/api/v1/analytics/trends`, {
                params: {
                    metric_name: 'workflow_executions',
                    interval: '1 hour'
                },
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                }
            });
            return response.data.data;
        },
        refetchInterval: 10000
    });

    // Fetch recent executions
    const { data: executionsData } = useQuery({
        queryKey: ['recent-executions'],
        queryFn: async () => {
            const response = await axios.get(`${API_BASE_URL}/api/v1/executions`, {
                params: {
                    limit: 10
                },
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                }
            });
            return response.data.data;
        },
        refetchInterval: 5000
    });

    // Format trend data for chart
    const formatTrendData = () => {
        if (!trendsData) return [];
        return trendsData.map((item: any) => ({
            time: new Date(item.time_bucket).toLocaleTimeString(),
            count: item.count,
            avg: Math.round(item.avg_value || 0)
        }));
    };

    // Format event distribution
    const eventDistribution = [
        { name: 'Completed', value: summaryData?.successfulExecutions || 0 },
        { name: 'Failed', value: summaryData?.failedExecutions || 0 }
    ];

    const COLORS = ['#10b981', '#ef4444'];

    return (
        <div className="min-h-screen bg-gray-50 p-8">
            {/* Header */}
            <div className="mb-8">
                <h1 className="text-4xl font-bold text-gray-900">Dashboard</h1>
                <p className="text-gray-600 mt-2">Real-time automation and analytics overview</p>
            </div>

            {/* Key Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <MetricCard
                    title="Total Events"
                    value={summaryData?.totalEvents || 0}
                    trend="up"
                    change={12}
                />
                <MetricCard
                    title="Active Users"
                    value={summaryData?.totalUsers || 0}
                    trend="up"
                    change={8}
                />
                <MetricCard
                    title="Total Workflows"
                    value={summaryData?.totalWorkflows || 0}
                    trend="up"
                    change={3}
                />
                <MetricCard
                    title="Success Rate"
                    value={`${Math.round(
                        (summaryData?.successfulExecutions || 0) /
                        ((summaryData?.successfulExecutions || 0) + (summaryData?.failedExecutions || 0)) *
                        100
                    )}%`}
                    trend="up"
                    change={2}
                />
            </div>

            {/* Charts Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                {/* Execution Trends */}
                <div className="bg-white rounded-lg shadow p-6">
                    <h2 className="text-xl font-semibold text-gray-900 mb-4">Execution Trends</h2>
                    <ResponsiveContainer width="100%" height={300}>
                        <AreaChart data={formatTrendData()}>
                            <defs>
                                <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="time" />
                            <YAxis />
                            <Tooltip />
                            <Area
                                type="monotone"
                                dataKey="count"
                                stroke="#3b82f6"
                                fillOpacity={1}
                                fill="url(#colorCount)"
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>

                {/* Execution Status Distribution */}
                <div className="bg-white rounded-lg shadow p-6">
                    <h2 className="text-xl font-semibold text-gray-900 mb-4">Execution Status</h2>
                    <ResponsiveContainer width="100%" height={300}>
                        <PieChart>
                            <Pie
                                data={eventDistribution}
                                cx="50%"
                                cy="50%"
                                labelLine={false}
                                label={({ name, value }) => `${name}: ${value}`}
                                outerRadius={80}
                                fill="#8884d8"
                                dataKey="value"
                            >
                                {eventDistribution.map((entry, index) => (
                                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                ))}
                            </Pie>
                            <Tooltip />
                        </PieChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* Recent Executions Table */}
            <div className="bg-white rounded-lg shadow overflow-hidden">
                <div className="p-6 border-b border-gray-200">
                    <h2 className="text-xl font-semibold text-gray-900">Recent Executions</h2>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-gray-50 border-b border-gray-200">
                            <tr>
                                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                                    Workflow
                                </th>
                                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                                    Status
                                </th>
                                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                                    Duration
                                </th>
                                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
                                    Timestamp
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {executionsData?.map((execution: any) => (
                                <tr key={execution.id} className="hover:bg-gray-50">
                                    <td className="px-6 py-4 text-sm text-gray-900">
                                        {execution.workflow_id}
                                    </td>
                                    <td className="px-6 py-4 text-sm">
                                        <StatusBadge status={execution.status} />
                                    </td>
                                    <td className="px-6 py-4 text-sm text-gray-600">
                                        {execution.duration_ms}ms
                                    </td>
                                    <td className="px-6 py-4 text-sm text-gray-600">
                                        {new Date(execution.created_at).toLocaleString()}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

// Metric Card Component
const MetricCard: React.FC<MetricCard> = ({ title, value, change, trend }) => {
    return (
        <div className="bg-white rounded-lg shadow p-6">
            <p className="text-gray-600 text-sm font-medium">{title}</p>
            <div className="mt-2 flex items-baseline justify-between">
                <p className="text-3xl font-bold text-gray-900">{value}</p>
                {change !== undefined && (
                    <p
                        className={clsx(
                            'text-sm font-semibold',
                            trend === 'up' ? 'text-green-600' : 'text-red-600'
                        )}
                    >
                        {trend === 'up' ? '↑' : '↓'} {change}%
                    </p>
                )}
            </div>
        </div>
    );
};

// Status Badge Component
const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
    const colors = {
        completed: 'bg-green-100 text-green-800',
        failed: 'bg-red-100 text-red-800',
        running: 'bg-blue-100 text-blue-800',
        pending: 'bg-yellow-100 text-yellow-800'
    };

    return (
        <span
            className={clsx(
                'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800'
            )}
        >
            {status}
        </span>
    );
};

export default Dashboard;
